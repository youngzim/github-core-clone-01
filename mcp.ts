// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at POST /mcp. It speaks the modern
// 2026-07-28 revision (server/discover, no handshake) and the legacy initialize handshake, and its
// tools act on the same store as REST and GraphQL (store.ts), so an object made over MCP is the
// same object over /api/v3. Tool results carry both a text block and structuredContent with the
// REST-shaped object, which is what the suite reads back.

import {
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  createPullRequest,
  createRepo,
  getRepo,
  mergePullRequest,
  type IssueRec,
  type Repo,
} from './store.ts';
import { issueJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: { name: str('The repository name'), description: str('A short description of the repository'), private: { type: 'boolean', description: 'Whether the repository is private' } },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name') },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), title: str('The issue title'), body: str('The issue body') },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its number.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), issue_number: { type: 'integer', description: 'The issue number' } },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), state: str('Filter by state: open, closed or all') },
    required: ['owner', 'repo'],
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), issue_number: { type: 'integer', description: 'The issue or pull request number' }, body: str('The comment body') },
    required: ['owner', 'repo', 'issue_number', 'body'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), title: str('The pull request title'), head: str('The head branch'), base: str('The base branch'), body: str('The pull request body') },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by its number.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), pull_number: { type: 'integer', description: 'The pull request number' } },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state (open, closed or all).',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), state: str('Filter by state: open, closed or all') },
    required: ['owner', 'repo', 'state'].slice(0, 2),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: { owner: str('The repository owner login'), repo: str('The repository name'), pull_number: { type: 'integer', description: 'The pull request number' }, merge_method: str('The merge method: merge, squash or rebase') },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list answer: built once, so two calls are byte-for-byte identical. */
const TOOLS = TOOL_DEFS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: tool.properties,
    required: [...tool.required],
  },
}));

const TOOL_BY_NAME = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { ok: true; payload: unknown } | { ok: false; message: string };

function repoFromArgs(args: Readonly<Record<string, unknown>>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || name === '') return null;
  return getRepo(owner, name);
}

function runTool(name: string, args: Readonly<Record<string, unknown>>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (getRepo(VIEWER.login, repoName) !== null) return { ok: false, message: `repository ${repoName} already exists` };
      const repo = createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { ok: true, payload: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = repoFromArgs(args);
      return repo ? { ok: true, payload: repoJson(repo) } : { ok: false, message: 'repository not found' };
    }
    case 'create_issue': {
      const repo = repoFromArgs(args);
      if (!repo) return { ok: false, message: 'repository not found' };
      const issue = createIssue(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { ok: true, payload: issueJson(repo, issue) };
    }
    case 'get_issue': {
      const repo = repoFromArgs(args);
      const item = repo?.items.get(Number(args.issue_number));
      return repo && item ? { ok: true, payload: issueJson(repo, item) } : { ok: false, message: 'issue not found' };
    }
    case 'list_issues': {
      const repo = repoFromArgs(args);
      if (!repo) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return { ok: true, payload: items.map((item) => issueJson(repo, item)) };
    }
    case 'add_issue_comment': {
      const repo = repoFromArgs(args);
      const item = repo?.items.get(Number(args.issue_number));
      if (!repo || !item) return { ok: false, message: 'issue not found' };
      const comment = addComment(repo, item, typeof args.body === 'string' ? args.body : '');
      return { ok: true, payload: { id: comment.id, body: comment.body } };
    }
    case 'create_pull_request': {
      const repo = repoFromArgs(args);
      if (!repo) return { ok: false, message: 'repository not found' };
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (branchTip(repo, base) === null) return { ok: false, message: `base branch ${base} does not exist` };
      if (branchTip(repo, head) === null) return { ok: false, message: `head branch ${head} does not exist` };
      const existing = [...repo.items.values()].find(
        (item: IssueRec) => item.kind === 'pr' && item.state === 'open' && item.head === head && item.base === base,
      );
      if (existing) return { ok: false, message: 'a pull request already exists for this head and base' };
      const pull = createPullRequest(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return { ok: true, payload: issueJson(repo, pull) };
    }
    case 'get_pull_request': {
      const repo = repoFromArgs(args);
      const item = repo?.items.get(Number(args.pull_number));
      return repo && item && item.kind === 'pr' ? { ok: true, payload: issueJson(repo, item) } : { ok: false, message: 'pull request not found' };
    }
    case 'list_pull_requests': {
      const repo = repoFromArgs(args);
      if (!repo) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return { ok: true, payload: items.map((item) => issueJson(repo, item)) };
    }
    case 'merge_pull_request': {
      const repo = repoFromArgs(args);
      const item = repo?.items.get(Number(args.pull_number));
      if (!repo || !item || item.kind !== 'pr') return { ok: false, message: 'pull request not found' };
      const methodRaw = typeof args.merge_method === 'string' ? args.merge_method : 'merge';
      const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
      const outcome = mergePullRequest(repo, item, method);
      if (!outcome.ok) return { ok: false, message: outcome.reason === 'conflict' ? 'pull request is not mergeable' : 'pull request cannot be merged' };
      return { ok: true, payload: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', pull_request: issueJson(repo, item) } };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

interface RpcReply {
  readonly status: number;
  readonly json?: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcReply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcReply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function dispatch(request: Record<string, unknown>): RpcReply {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined) return { status: 202 }; // a notification: accepted, no answer
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return rpcError(id, -32602, `Tool not found: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined);
      if (missing.length) return rpcError(id, -32602, `Missing required argument: ${missing.join(', ')}`);
      const outcome = runTool(name, args);
      if (!outcome.ok) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
        isError: false,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMCP(bodyText: string): RpcReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => dispatch(entry))
      .filter((reply) => reply.json !== undefined)
      .map((reply) => reply.json);
    return replies.length ? { status: 200, json: replies } : { status: 202 };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  return dispatch(parsed as Record<string, unknown>);
}
