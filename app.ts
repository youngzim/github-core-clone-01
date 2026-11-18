// The forge's HTTP server: one process serving git smart HTTP (/<owner>/<repo>.git), REST v3
// (/api/v3), GraphQL (/api/graphql) and MCP (/mcp) over the shared store. This file owns only the
// transport concerns every surface shares: the bearer-token gate (the token in MAKEFUN_SHOP_TOKEN
// names the viewer; /healthz is the one open route), a request id on every reply, JSON error
// bodies, and a hard guarantee that a handler failure becomes a 500, never a hung socket.
//
// main.ts (the harness lifecycle) imports createApp from here and stays as the starter shipped it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMCP } from './mcp.ts';
import { handleRest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `makefun-${requestCounter.toString(16).padStart(6, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': body.length,
  });
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${EXPECTED_TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  // The env's boot probe: open, tokenless, always the same answer.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else sits behind the shop token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    const reply = handleGraphQL(body.toString('utf8'));
    sendJson(res, reply.status, reply.json);
    return;
  }

  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 204, undefined);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const reply = handleMCP(body.toString('utf8'));
    if (reply.json === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.json);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const body = method === 'GET' || method === 'HEAD' ? '' : (await readBody(req)).toString('utf8');
    const rawQuery = url.search.replace(/^\?/, '');
    const reply = handleRest(method, segments, url.searchParams, rawQuery, body, req.headers.host ?? 'entry');
    if (reply.json === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId(), ...(reply.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.json, reply.headers ?? {});
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1]!);
    const repo = decodeSegment(gitMatch[2]!);
    const service = gitMatch[3]!;
    const protocol = req.headers['git-protocol'] ?? null;
    try {
      if (service === 'info/refs' && method === 'GET') {
        const reply = handleInfoRefs(owner, repo, url.searchParams.get('service'), typeof protocol === 'string' ? protocol : null);
        sendRaw(res, reply.status, reply.contentType, reply.body);
        return;
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        const reply = handleUploadPack(owner, repo, body, typeof protocol === 'string' ? protocol : null);
        sendRaw(res, reply.status, reply.contentType, reply.body);
        return;
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        const reply = handleReceivePack(owner, repo, body);
        sendRaw(res, reply.status, reply.contentType, reply.body);
        return;
      }
    } catch (err) {
      // A malformed protocol body (the suite sends one on purpose) is a 400, never a crash.
      process.stderr.write(`[forge] git ${service} error: ${err instanceof Error ? err.message : String(err)}\n`);
      sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from('error: malformed request\n', 'utf8'));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}
