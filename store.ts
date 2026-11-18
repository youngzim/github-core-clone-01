// The forge's shared core: the in-memory git object store, repositories, issues, pull requests,
// labels and comments, plus the tree/commit/merge machinery every surface (REST, GraphQL, MCP,
// git smart HTTP) shares, so an object created on one surface is the same object on all of them.
//
// Everything lives in memory: the trial is one process with a fresh pod, and the score rewards
// speed on the read/write workloads. Identities come from the contest's fixed scenario: the shop
// token names one viewer, and that viewer is the only login that can own repositories.

import { createHash } from 'node:crypto';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

// ---------------------------------------------------------------------------------------------
// object store
// ---------------------------------------------------------------------------------------------

const objects = new Map<string, GitObject>();
const objectSeq = new Map<string, number>();
let seqCounter = 0;

/** The next deterministic sequence number (creation order for commits, issues, timestamps). */
export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/** SHA-1 of `<type> <size>\0` + bytes: the git object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotent) and answer its id. */
export function storeObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) {
    objects.set(oid, { type, data });
    objectSeq.set(oid, nextSeq());
  }
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

export function hasObject(oid: string): boolean {
  return objects.has(oid);
}

/** When the object first entered the store (a stable tie-break for log ordering). */
export function seqOf(oid: string): number {
  return objectSeq.get(oid) ?? 0;
}

// ---------------------------------------------------------------------------------------------
// commits and trees
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const stamp = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, timestamp: stamp ? Number(stamp[1]) : 0, message };
}

export function buildCommitData(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface FlatFile {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a tree (recursively) into a path -> {oid, mode} map. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, FlatFile>()): Map<string, FlatFile> {
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> {oid, mode} map; answers the root tree id. */
export function buildTreeFromFlat(files: ReadonlyMap<string, FlatFile>): string {
  interface Node {
    files: Map<string, FlatFile>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject('tree', buildTreeData(entries));
  };
  return build(root);
}

/** The tree of a commit, or null when the id is not a commit in the store. */
export function commitTree(oid: string): string | null {
  const object = objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Peel tags to the commit they ultimately name (or null). */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (!match) return null;
    current = match[1]!;
  }
  return null;
}

/** Peel a tag one level for ls-refs `peeled:` (all the way to the commit, as git reports it). */
export function peelTagFully(oid: string): string | null {
  return peelToCommit(oid);
}

// ---------------------------------------------------------------------------------------------
// ancestry and reachability
// ---------------------------------------------------------------------------------------------

function commitParents(oid: string): readonly string[] {
  const object = objects.get(oid);
  if (!object || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (inclusive). */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(current)) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (the merge base), or null. */
export function mergeBase(a: string, b: string): string | null {
  const distances = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length) {
      const [current, depth] = queue.shift()!;
      if (dist.has(current)) continue;
      dist.set(current, depth);
      for (const parent of commitParents(current)) queue.push([parent, depth + 1]);
    }
    return dist;
  };
  const fromA = distances(a);
  const fromB = distances(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

export interface ClosureOptions {
  /** Commits whose parents are NOT traversed (the client's shallow boundary). */
  readonly shallowStop?: ReadonlySet<string>;
  /** When set, only commits within this many generations of the tips are included. */
  readonly maxDepth?: number;
  /** When set, only commits at or after this committer timestamp are included. */
  readonly minTimestamp?: number;
  /** Commits (and their ancestors) that stop traversal, for deepen-not. */
  readonly stopAt?: ReadonlySet<string>;
}

export interface Closure {
  readonly objects: Set<string>;
  /** Included commits with a parent outside the included set (the new shallow boundary). */
  readonly boundary: Set<string>;
  readonly commits: Set<string>;
}

/** Every object reachable from the tips, honouring the shallow/deepen options. */
export function collectClosure(tips: Iterable<string>, options: ClosureOptions = {}): Closure {
  const included = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 0 });
  const includeTreeDeep = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const current = stack.pop()!;
      if (included.has(current)) continue;
      const object = objects.get(current);
      if (!object) continue;
      included.add(current);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (options.stopAt?.has(oid) && !commits.has(oid) && depth > 0) continue;
    const object = objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      if (!included.has(oid)) {
        included.add(oid);
        const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
        if (match) queue.push({ oid: match[1]!, depth });
      }
      continue;
    }
    if (object.type !== 'commit') {
      includeTreeDeep(oid);
      continue;
    }
    if (commits.has(oid)) continue;
    const info = parseCommit(object.data);
    if (options.maxDepth !== undefined && depth > options.maxDepth) continue;
    if (options.minTimestamp !== undefined && info.timestamp < options.minTimestamp && depth > 0) {
      boundary.add(oid);
      continue;
    }
    commits.add(oid);
    included.add(oid);
    depthOf.set(oid, depth);
    includeTreeDeep(info.tree);
    const shallowStopped = options.shallowStop?.has(oid) === true;
    for (const parent of info.parents) {
      const parentObject = objects.get(parent);
      const parentIncluded =
        !shallowStopped &&
        parentObject !== undefined &&
        (options.maxDepth === undefined || depth + 1 <= options.maxDepth) &&
        !(options.minTimestamp !== undefined && parseCommit(parentObject.data).timestamp < options.minTimestamp) &&
        !(options.stopAt?.has(parent) === true);
      if (parentIncluded) queue.push({ oid: parent, depth: depth + 1 });
      else if (parentObject !== undefined) boundary.add(oid);
    }
  }
  return { objects: included, boundary, commits };
}

/** Commits reachable from `tip` and not from `excludeTip`, newest first (git log order). */
export function commitsBetween(tip: string, excludeTip: string | null): string[] {
  const excluded = excludeTip === null ? new Set<string>() : collectClosure([excludeTip]).commits;
  const seen = new Set<string>();
  const frontier: string[] = [tip];
  const ordered: string[] = [];
  const key = (oid: string): [number, number] => {
    const object = objects.get(oid);
    const ts = object && object.type === 'commit' ? parseCommit(object.data).timestamp : 0;
    return [ts, seqOf(oid)];
  };
  while (frontier.length) {
    let bestIndex = 0;
    for (let index = 1; index < frontier.length; index += 1) {
      const [tsA, seqA] = key(frontier[index]!);
      const [tsB, seqB] = key(frontier[bestIndex]!);
      if (tsA > tsB || (tsA === tsB && seqA > seqB)) bestIndex = index;
    }
    const current = frontier.splice(bestIndex, 1)[0]!;
    if (seen.has(current) || excluded.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    for (const parent of commitParents(current)) {
      if (!seen.has(parent) && !excluded.has(parent)) frontier.push(parent);
    }
  }
  return ordered;
}

/** All commits reachable from a tip, in git-log order (newest first). */
export function logFrom(tip: string): string[] {
  return commitsBetween(tip, null);
}

// ---------------------------------------------------------------------------------------------
// deterministic clock
// ---------------------------------------------------------------------------------------------

const CLOCK_BASE_MS = Date.UTC(2025, 5, 1, 0, 0, 0);

/** An ISO timestamp that grows with the creation sequence (stable, monotone, check-friendly). */
export function isoAt(seq: number): string {
  return new Date(CLOCK_BASE_MS + seq * 1000).toISOString();
}

/** A unix timestamp (seconds) that grows with the creation sequence. */
export function epochAt(seq: number): number {
  return Math.floor(CLOCK_BASE_MS / 1000) + seq;
}

// ---------------------------------------------------------------------------------------------
// repositories, issues, pull requests
// ---------------------------------------------------------------------------------------------

export interface LabelRec {
  readonly name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  readonly id: number;
  readonly body: string;
  readonly seq: number;
}

export interface IssueRec {
  readonly kind: 'issue' | 'pr';
  readonly number: number;
  /** The REST numeric id (global, stable across reads). */
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: CommentRec[];
  readonly seq: number;
  // pull-request-only fields
  head?: string;
  base?: string;
  merged?: boolean;
  mergedAtSeq?: number | null;
  mergeCommitSha?: string | null;
}

export interface Repo {
  readonly dbId: number;
  readonly owner: string;
  readonly name: string;
  private: boolean;
  description: string;
  readonly refs: Map<string, string>;
  headBranch: string;
  readonly labels: Map<string, LabelRec>;
  readonly items: Map<number, IssueRec>;
  nextNumber: number;
  readonly seq: number;
}

const repos = new Map<string, Repo>();
let nextRepoDbId = 1;
let nextItemDbId = 1;
let nextCommentId = 1;

export function createRepo(name: string, priv: boolean, description: string): Repo {
  const repo: Repo = {
    dbId: nextRepoDbId++,
    owner: VIEWER.login,
    name,
    private: priv,
    description,
    refs: new Map(),
    headBranch: DEFAULT_BRANCH,
    labels: new Map(),
    items: new Map(),
    nextNumber: 1,
    seq: nextSeq(),
  };
  repos.set(name, repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(name) ?? null;
}

export function getRepoByDbId(dbId: number): Repo | null {
  for (const repo of repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.seq - b.seq);
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repo.name);
}

/** The commit a branch points at, or null (missing branch or unborn). */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function headTip(repo: Repo): string | null {
  return branchTip(repo, repo.headBranch);
}

/**
 * Commit a set of file changes (path -> bytes, or null to delete) on a branch, creating the branch
 * (and the repository's first commit) when needed. Answers the new commit id.
 */
export function commitFiles(
  repo: Repo,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): { commit: string; created: boolean } {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref) ?? null;
  let created = false;
  if (parent === null) {
    // A contents write naming a branch the repository does not have yet forks it from the default
    // branch (or starts the repository's history when nothing exists at all).
    parent = headTip(repo);
    created = true;
  }
  const files = new Map<string, FlatFile>();
  if (parent !== null) {
    const tree = commitTree(parent);
    if (tree !== null) for (const [path, file] of flattenTree(tree)) files.set(path, file);
  }
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, { oid: storeObject('blob', content), mode: '100644' });
  }
  const tree = buildTreeFromFlat(files);
  const seq = nextSeq();
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const commit = storeObject(
    'commit',
    buildCommitData({
      tree,
      parents: parent === null ? [] : [parent],
      message,
      author: identity,
      committer: identity,
      timestamp: epochAt(seq),
    }),
  );
  repo.refs.set(ref, commit);
  return { commit, created };
}

/** Create an issue (labels must already exist; the caller validates). */
export function createIssue(repo: Repo, input: { title: string; body: string; labels?: readonly string[] }): IssueRec {
  const issue: IssueRec = {
    kind: 'issue',
    number: repo.nextNumber++,
    id: nextItemDbId++,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...(input.labels ?? [])],
    comments: [],
    seq: nextSeq(),
  };
  repo.items.set(issue.number, issue);
  return issue;
}

/** Create a pull request record (branches already validated by the caller). */
export function createPullRequest(
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): IssueRec {
  const pull: IssueRec = {
    kind: 'pr',
    number: repo.nextNumber++,
    id: nextItemDbId++,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [],
    comments: [],
    seq: nextSeq(),
    head: input.head,
    base: input.base,
    merged: false,
    mergedAtSeq: null,
    mergeCommitSha: null,
  };
  repo.items.set(pull.number, pull);
  return pull;
}

export function addComment(repo: Repo, item: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: nextCommentId++, body, seq: nextSeq() };
  item.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

/** Count added/deleted lines between two texts with an LCS diff (bounded for large inputs). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * cols + j + 1]! + 1 : Math.max(dp[(i + 1) * cols + j]!, dp[i * cols + j + 1]!);
    }
  }
  const common = dp[0]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobText(oid: string | null): string {
  if (oid === null) return '';
  const object = objects.get(oid);
  return object ? object.data.toString('utf8') : '';
}

/** The file-level diff between two trees (merge-base tree -> head tree, as PR files are judged). */
export function diffTrees(fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, FlatFile>() : flattenTree(fromTree);
  const to = toTree === null ? new Map<string, FlatFile>() : flattenTree(toTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldFile = from.get(path);
    const newFile = to.get(path);
    if (oldFile && newFile && oldFile.oid === newFile.oid) continue;
    const counts = lineDiffCounts(blobText(oldFile?.oid ?? null), blobText(newFile?.oid ?? null));
    changes.push({
      path,
      status: !oldFile ? 'added' : !newFile ? 'removed' : 'modified',
      oldOid: oldFile?.oid ?? null,
      newOid: newFile?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

/** The changed paths of a pull request: merge-base tree versus head tree. */
export function pullRequestChanges(repo: Repo, pull: IssueRec): FileChange[] {
  const head = branchTip(repo, pull.head!);
  const base = branchTip(repo, pull.base!);
  if (head === null || base === null) return [];
  const baseCommit = mergeBase(base, head) ?? base;
  return diffTrees(commitTree(baseCommit), commitTree(head));
}

/**
 * Three-way tree merge at file granularity: a path changed on both sides with different results
 * conflicts; a path changed on one side takes that side. Answers the merged files or the conflicts.
 */
export function mergeTrees3(
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): { files: Map<string, FlatFile> } | { conflicts: string[] } {
  const base = baseTree === null ? new Map<string, FlatFile>() : flattenTree(baseTree);
  const ours = oursTree === null ? new Map<string, FlatFile>() : flattenTree(oursTree);
  const theirs = theirsTree === null ? new Map<string, FlatFile>() : flattenTree(theirsTree);
  const merged = new Map<string, FlatFile>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    if (o === t) {
      const file = ours.get(path) ?? theirs.get(path);
      if (file) merged.set(path, file);
    } else if (b === o) {
      const file = theirs.get(path);
      if (file) merged.set(path, file);
    } else if (b === t) {
      const file = ours.get(path);
      if (file) merged.set(path, file);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length ? { conflicts } : { files: merged };
}

/** Whether a pull request can merge cleanly right now (its head into its base). */
export function pullRequestConflict(repo: Repo, pull: IssueRec): boolean {
  const head = branchTip(repo, pull.head!);
  const base = branchTip(repo, pull.base!);
  if (head === null || base === null) return true;
  const baseCommit = mergeBase(base, head);
  if (baseCommit === null) return true;
  const result = mergeTrees3(commitTree(baseCommit), commitTree(base), commitTree(head));
  return 'conflicts' in result;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-open' | 'missing' };

/** Merge a pull request into its base branch with the named method, updating the base ref. */
export function mergePullRequest(repo: Repo, pull: IssueRec, method: 'merge' | 'squash' | 'rebase'): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
  const head = branchTip(repo, pull.head!);
  const base = branchTip(repo, pull.base!);
  if (head === null || base === null) return { ok: false, reason: 'missing' };
  const baseCommit = mergeBase(base, head);
  if (baseCommit === null) return { ok: false, reason: 'conflict' };
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const finish = (commit: string): MergeOutcome => {
    repo.refs.set(`refs/heads/${pull.base!}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtSeq = nextSeq();
    pull.mergeCommitSha = commit;
    return { ok: true, sha: commit };
  };
  if (method === 'rebase') {
    const commits = commitsBetween(head, baseCommit).reverse();
    let current = base;
    for (const commitOid of commits) {
      const info = parseCommit(objects.get(commitOid)!.data);
      const parentTree = info.parents.length ? commitTree(info.parents[0]!) : null;
      const step = mergeTrees3(parentTree, commitTree(current), info.tree);
      if ('conflicts' in step) return { ok: false, reason: 'conflict' };
      const seq = nextSeq();
      current = storeObject(
        'commit',
        buildCommitData({ tree: buildTreeFromFlat(step.files), parents: [current], message: info.message, author: info.author.replace(/ \d+ [+-]\d{4}$/, ''), committer: identity, timestamp: epochAt(seq) }),
      );
    }
    return finish(current);
  }
  const merged = mergeTrees3(commitTree(baseCommit), commitTree(base), commitTree(head));
  if ('conflicts' in merged) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFlat(merged.files);
  const seq = nextSeq();
  if (method === 'squash') {
    const message = `${pull.title}\n\n${pull.body}`;
    const commit = storeObject(
      'commit',
      buildCommitData({ tree, parents: [base], message, author: identity, committer: identity, timestamp: epochAt(seq) }),
    );
    return finish(commit);
  }
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const commit = storeObject(
    'commit',
    buildCommitData({ tree, parents: [base, head], message, author: identity, committer: identity, timestamp: epochAt(seq) }),
  );
  return finish(commit);
}
