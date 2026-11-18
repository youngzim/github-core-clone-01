// Git smart HTTP, implemented from the protocol up: pkt-lines, packfiles (plain objects out,
// plain + OFS/REF deltas in), protocol v2 upload-pack (ls-refs and fetch, with shallow support),
// the v0 upload-pack fallback, and v0 receive-pack with report-status and fast-forward rules.
//
// No git binary exists in the trial pod, so this file is the whole transport. It works against the
// shared object store in store.ts: objects a push stores are the objects REST and GraphQL read.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectClosure,
  getObject,
  getRepo,
  hashObject,
  isAncestor,
  parseCommit,
  peelToCommit,
  storeObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

const AGENT = 'makefun-forge/1.0';
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse a whole pkt-line stream; throws on malformed framing (the caller turns that into a 400). */
export function parsePackets(buffer: Buffer, start = 0): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: offset };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain (undeltified) objects in the given order. */
export function writePack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = getObject(oid);
    if (!object) continue;
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile, resolve every delta, verify the trailer, and store the objects.
 * Throws (with a git-flavoured message) on any structural problem; the caller reports it as an
 * unpack failure and applies no ref updates.
 */
export function readPackAndStore(pack: Buffer): number {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!computed.equals(pack.subarray(trailerStart))) throw new Error('pack checksum mismatch');
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++]!;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++]!;
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const memo = resolved.get(entry.offset);
    if (memo) return memo;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const existing = getObject(entry.baseOid!);
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (existing) base = existing;
      else {
        for (const candidate of raw) {
          if (candidate.typeCode === 6 || candidate.typeCode === 7) continue;
          if (hashObject(CODE_TYPE[candidate.typeCode]!, candidate.data) === entry.baseOid) {
            base = resolve(candidate);
            break;
          }
        }
      }
      if (!base) throw new Error('ref-delta base is not available');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = storeObject(type, data);
    const value = { type, data, oid };
    resolved.set(entry.offset, value);
    return value;
  };
  for (const entry of raw) resolve(entry);
  return raw.length;
}

// ---------------------------------------------------------------------------------------------
// ref advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.headBranch}`) ?? ZERO_OID;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.headBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const emit = (oid: string, name: string): void => {
      lines.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
    };
    emit(headOid(repo), 'HEAD');
    for (const [name, oid] of refs) {
      emit(oid, name);
      if (name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(oid);
        if (peeled !== null && peeled !== oid) lines.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

function lsRefs(repo: Repo, packets: Packet[]): Buffer {
  let sawDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !sawDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.headBranch}`;
  const tip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (tip !== undefined) {
      lines.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function computeFetch(repo: Repo, args: FetchArgs): { send: string[]; shallowLines: string[]; unshallowLines: string[]; common: string[] } {
  const haveClosure = collectClosure(args.haves, { shallowStop: new Set(args.shallow) });
  let selection;
  if (args.deepen !== null) {
    selection = collectClosure(args.wants, { maxDepth: Math.max(0, args.deepen - 1) });
  } else if (args.deepenSince !== null) {
    selection = collectClosure(args.wants, { minTimestamp: args.deepenSince });
  } else {
    selection = collectClosure(args.wants);
  }
  if (args.deepenNot.length) {
    const stops = new Set<string>();
    for (const name of args.deepenNot) {
      const oid = repo.refs.get(name) ?? repo.refs.get(`refs/heads/${name}`);
      if (oid) stops.add(oid);
    }
    if (stops.size) {
      const pruned = collectClosure(args.wants, { stopAt: stops });
      selection = pruned;
    }
  }
  const send = [...selection.objects].filter((oid) => !haveClosure.objects.has(oid));
  const shallowInvolved = args.deepen !== null || args.deepenSince !== null || args.shallow.length > 0;
  const shallowLines = shallowInvolved ? [...selection.boundary] : [];
  const unshallowLines = shallowInvolved
    ? args.shallow.filter((oid) => selection.commits.has(oid) && !selection.boundary.has(oid))
    : [];
  const common = args.haves.filter((oid) => getObject(oid) !== undefined);
  return { send, shallowLines, unshallowLines, common };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

function fetchV2(repo: Repo, packets: Packet[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false };
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !sawDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') args.done = true;
  }
  const { send, shallowLines, unshallowLines, common } = computeFetch(repo, args);
  const out: Buffer[] = [];
  if (args.haves.length) {
    out.push(pktLine('acknowledgments\n'));
    if (common.length === 0) out.push(pktLine('NAK\n'));
    else for (const oid of common) out.push(pktLine(`ACK ${oid} common\n`));
    if (args.done) out.push(pktLine('ready\n'));
    out.push(PKT_DELIM);
  }
  if (shallowLines.length || unshallowLines.length) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of shallowLines) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowLines) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(PKT_DELIM);
  }
  const wantsCovered = args.wants.every((oid) => !send.includes(oid));
  if (send.length > 0 || !wantsCovered) {
    const pack = writePack(send);
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPackets(pack));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function fetchV0(repo: Repo, packets: Packet[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line === 'done') args.done = true;
    }
  }
  const { send, shallowLines, unshallowLines, common } = computeFetch(repo, args);
  const out: Buffer[] = [];
  for (const oid of shallowLines) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowLines) out.push(pktLine(`unshallow ${oid}\n`));
  if (common.length === 0) out.push(pktLine('NAK\n'));
  else out.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  if (send.length > 0) {
    const pack = writePack(send);
    out.push(...sidebandPackets(pack));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Read one pkt-line at `offset`; returns the packet and the offset just past it. */
function readPacketAt(buffer: Buffer, offset: number): { packet: Packet; next: number } {
  if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
  const hex = buffer.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
  const length = parseInt(hex, 16);
  if (length === 0) return { packet: { kind: 'flush' }, next: offset + 4 };
  if (length === 1) return { packet: { kind: 'delim' }, next: offset + 4 };
  if (length === 2) return { packet: { kind: 'end' }, next: offset + 4 };
  if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
  return { packet: { kind: 'data', payload: buffer.subarray(offset + 4, offset + length) }, next: offset + length };
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let offset = 0;
  while (offset < body.length) {
    const { packet, next } = readPacketAt(body, offset);
    offset = next;
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  // Everything after the command list's flush packet is the pack (absent for delete-only pushes).
  const pack = body.subarray(offset);
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      readPackAndStore(pack);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError === null) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.oldOid !== current) {
        reports.push({ ref: command.ref, ok: false, reason: 'reference update refused' });
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          reports.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
          continue;
        }
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (!getObject(command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'unable to resolve object' });
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
        const currentCommit = peelToCommit(current);
        const newCommit = peelToCommit(command.newOid);
        if (currentCommit !== null && newCommit !== null && !isAncestor(currentCommit, newCommit)) {
          reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  if (!capabilities.has('report-status') && !capabilities.has('report-status-v2')) return Buffer.alloc(0);
  const lines: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const report of reports) {
    lines.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  lines.push(PKT_FLUSH);
  const reportStream = Buffer.concat(lines);
  if (capabilities.has('side-band-64k')) {
    const out: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
      out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  return reportStream;
}

// ---------------------------------------------------------------------------------------------
// HTTP handlers (called by app.ts with the fully-read request body)
// ---------------------------------------------------------------------------------------------

export interface GitReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const notFound = (): GitReply => ({
  status: 404,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from('{"message":"Not Found"}\n', 'utf8'),
});

export function handleInfoRefs(owner: string, name: string, service: string | null, protocolHeader: string | null): GitReply {
  const repo = getRepo(owner, name);
  if (!repo) return notFound();
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocolHeader !== null && /(^|,)\s*version=2/.test(protocolHeader)) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service) };
}

export function handleUploadPack(owner: string, name: string, body: Buffer, protocolHeader: string | null): GitReply {
  const repo = getRepo(owner, name);
  if (!repo) return notFound();
  const { packets } = parsePackets(body);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const commandLine = firstData && firstData.kind === 'data' ? firstData.payload.toString('utf8') : '';
  const wantsV2 = protocolHeader !== null && /(^|,)\s*version=2/.test(protocolHeader);
  if (commandLine.startsWith('command=ls-refs')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, packets) };
  }
  if (commandLine.startsWith('command=fetch')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, packets) };
  }
  if (wantsV2) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('error: unknown command\n', 'utf8') };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, packets) };
}

export function handleReceivePack(owner: string, name: string, body: Buffer): GitReply {
  const repo = getRepo(owner, name);
  if (!repo) return notFound();
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, body) };
}

/** Kept for app.ts's convenience: a commit's parsed view (REST commits share it). */
export function commitView(oid: string) {
  const object = getObject(oid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data);
}
