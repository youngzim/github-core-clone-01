// The GitHub REST v3 surface: repositories, contents, branches, commits, git refs, labels, issues,
// comments and pull requests, over the shared store in store.ts. Every handler answers the
// RestReply shape; app.ts adds the transport concerns (auth, request ids, JSON content type).

import {
  VIEWER,
  ZERO_OID,
  branchTip,
  commitFiles,
  createIssue,
  createPullRequest,
  createRepo,
  deleteRepo,
  flattenTree,
  getObject,
  getRepo,
  isoAt,
  listRepos,
  logFrom,
  mergePullRequest,
  parseCommit,
  parseTree,
  pullRequestChanges,
  pullRequestConflict,
  addComment,
  type IssueRec,
  type LabelRec,
  type Repo,
} from './store.ts';

export interface RestReply {
  readonly status: number;
  readonly json?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const ok = (json: unknown, status = 200): RestReply => ({ status, json });
const fail = (status: number, message: string): RestReply => ({ status, json: { message } });
const notFound = (): RestReply => fail(404, 'Not Found');
const validationFailed = (message: string): RestReply => ({
  status: 422,
  json: { message: 'Validation Failed', errors: [{ resource: 'Forge', code: 'custom', message }] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBody(bodyText: string): { value: Record<string, unknown> } | { error: RestReply } {
  if (bodyText.trim() === '') return { value: {} };
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isRecord(parsed)) return { error: fail(400, 'Problems parsing JSON') };
    return { value: parsed };
  } catch {
    return { error: fail(400, 'Problems parsing JSON') };
  }
}

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64'),
    avatar_url: '',
    html_url: '',
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.items.values()].filter((item) => item.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: Buffer.from(`Repository:${repo.dbId}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: '',
    description: repo.description,
    fork: false,
    created_at: isoAt(repo.seq),
    updated_at: isoAt(repo.seq),
    pushed_at: isoAt(repo.seq),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.headBranch,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

function identityOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(oid: string): Record<string, unknown> | null {
  const object = getObject(oid);
  if (!object || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      author: identityOf(info.author),
      committer: identityOf(info.committer),
      message: info.message,
      tree: { sha: info.tree },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

export function issueJson(repo: Repo, item: IssueRec): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: item.id,
    node_id: Buffer.from(`${item.kind === 'pr' ? 'PullRequest' : 'Issue'}:${repo.dbId}:${item.number}`, 'utf8').toString('base64'),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '', default: false, url: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: item.comments.length,
    created_at: isoAt(item.seq),
    updated_at: isoAt(item.seq),
    closed_at: item.state === 'closed' ? isoAt(item.seq) : null,
    url: '',
    html_url: '',
    repository_url: '',
  };
  if (item.kind === 'pr') {
    const headSha = branchTip(repo, item.head!) ?? item.mergeCommitSha ?? ZERO_OID;
    const baseSha = branchTip(repo, item.base!) ?? ZERO_OID;
    base.head = { label: `${repo.owner}:${item.head}`, ref: item.head, sha: headSha };
    base.base = { label: `${repo.owner}:${item.base}`, ref: item.base, sha: baseSha };
    base.merged = item.merged === true;
    base.merged_at = item.merged && item.mergedAtSeq != null ? isoAt(item.mergedAtSeq) : null;
    base.merge_commit_sha = item.mergeCommitSha ?? null;
    base.mergeable = item.merged ? true : !pullRequestConflict(repo, item);
    base.mergeable_state = base.mergeable ? 'clean' : 'dirty';
    base.draft = false;
    base.pull_request = { url: '', html_url: '', diff_url: '', patch_url: '' };
    const changes = item.merged ? [] : pullRequestChanges(repo, item);
    base.additions = changes.reduce((sum, change) => sum + change.additions, 0);
    base.deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
    base.changed_files = changes.length;
  }
  return base;
}

export function commentJson(repo: Repo, item: IssueRec, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.dbId}:${item.number}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoAt(comment.seq),
    updated_at: isoAt(comment.seq),
    issue_url: '',
    html_url: '',
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page<T> {
  readonly items: T[];
  readonly headers: Record<string, string>;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, rawQuery: string, baseUrl: string): Page<T> {
  const perPageRaw = Number(query.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(rawQuery);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${baseUrl}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { items: slice, headers: links.length ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

function createRepoHandler(bodyText: string): RestReply {
  const parsed = parseBody(bodyText);
  if ('error' in parsed) return parsed.error;
  const body = parsed.value;
  const name = typeof body.name === 'string' ? body.name : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name === '.' || name === '..') {
    return validationFailed('name is not valid');
  }
  if (getRepo(VIEWER.login, name) !== null) {
    return {
      status: 422,
      json: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const repo = createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
  return ok(repoJson(repo), 201);
}

function repoRoot(repo: Repo, method: string, rest: string[], query: URLSearchParams, rawQuery: string, bodyText: string, baseUrl: string): RestReply {
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204 };
    }
    if (method === 'PATCH') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      const body = parsed.value;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.headBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== repo.name) return validationFailed('renaming is not supported');
      return ok(repoJson(repo));
    }
    return notFound();
  }
  const [head, ...tail] = rest as [string, ...string[]];
  switch (head) {
    case 'contents':
      return contents(repo, method, tail.join('/'), query, bodyText);
    case 'git':
      return gitData(repo, method, tail, bodyText);
    case 'branches':
      return branches(repo, method, tail);
    case 'commits':
      return commits(repo, method, tail, query, rawQuery, baseUrl);
    case 'labels':
      return labels(repo, method, tail, bodyText);
    case 'issues':
      return issues(repo, method, tail, query, rawQuery, bodyText, baseUrl);
    case 'pulls':
      return pulls(repo, method, tail, query, rawQuery, bodyText, baseUrl);
    default:
      return notFound();
  }
}

// --- contents ---

function contents(repo: Repo, method: string, path: string, query: URLSearchParams, bodyText: string): RestReply {
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.headBranch;
    let tip = branchTip(repo, ref);
    if (tip === null && /^[0-9a-f]{40}$/.test(ref) && getObject(ref)?.type === 'commit') tip = ref;
    if (tip === null) {
      const tagTip = repo.refs.get(`refs/tags/${ref}`);
      if (tagTip !== undefined) tip = tagTip;
    }
    if (tip === null) return fail(404, 'Not Found');
    const commit = getObject(tip);
    if (!commit || commit.type !== 'commit') return fail(404, 'Not Found');
    const tree = parseCommit(commit.data).tree;
    const files = flattenTree(tree);
    if (cleanPath === '') {
      return ok(dirListing(repo, files, ''));
    }
    const file = files.get(cleanPath);
    if (file) {
      const blob = getObject(file.oid);
      const data = blob ? blob.data : Buffer.alloc(0);
      return ok({
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: cleanPath.split('/').pop(),
        path: cleanPath,
        sha: file.oid,
        content: data.toString('base64'),
        url: '',
        html_url: '',
        download_url: '',
      });
    }
    const prefix = `${cleanPath}/`;
    const isDir = [...files.keys()].some((key) => key.startsWith(prefix));
    if (isDir) return ok(dirListing(repo, files, cleanPath));
    return fail(404, 'Not Found');
  }
  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(bodyText);
    if ('error' in parsed) return parsed.error;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.headBranch;
    const tip = branchTip(repo, branch);
    const files = tip === null ? new Map() : flattenTree(parseCommit(getObject(tip)!.data).tree);
    const existing = files.get(cleanPath);
    if (method === 'DELETE') {
      if (!existing) return fail(404, 'Not Found');
      if (typeof body.sha !== 'string' || body.sha !== existing.oid) return fail(409, 'sha does not match');
      const { commit } = commitFiles(repo, branch, new Map([[cleanPath, null]]), message);
      return ok({ content: null, commit: { sha: commit, message } });
    }
    if (typeof body.content !== 'string') return validationFailed('content is required');
    if (!/^[A-Za-z0-9+/=\r\n ]*$/.test(body.content)) return validationFailed('content is not valid base64');
    const data = Buffer.from(body.content, 'base64');
    if (existing) {
      if (typeof body.sha !== 'string' || body.sha !== existing.oid) return fail(409, `${cleanPath} does not match the given sha`);
    }
    const { commit } = commitFiles(repo, branch, new Map([[cleanPath, data]]), message);
    const blobOid = flattenTree(parseCommit(getObject(commit)!.data).tree).get(cleanPath)!.oid;
    return ok(
      {
        content: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: cleanPath.split('/').pop(),
          path: cleanPath,
          sha: blobOid,
          url: '',
          html_url: '',
          download_url: '',
        },
        commit: { sha: commit, message },
      },
      existing ? 200 : 201,
    );
  }
  return notFound();
}

function dirListing(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  void repo;
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', size: getObject(file.oid)?.data.length ?? 0, name: rest, path, sha: file.oid, url: '', html_url: '', download_url: '' });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // The directory's tree id: walk to it for a real sha.
        seen.set(name, { type: 'dir', size: 0, name, path: `${prefix}${name}`, sha: dirTreeSha(repo, files, `${prefix}${name}`), url: '', html_url: '', download_url: '' });
      }
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function dirTreeSha(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>, dirPath: string): string {
  void files;
  const tip = branchTip(repo, repo.headBranch);
  if (tip === null) return ZERO_OID;
  let tree = parseCommit(getObject(tip)!.data).tree;
  for (const segment of dirPath.split('/')) {
    const found = treeEntry(tree, segment);
    if (found === null) return ZERO_OID;
    tree = found;
  }
  return tree;
}

function treeEntry(treeOid: string, name: string): string | null {
  const object = getObject(treeOid);
  if (!object || object.type !== 'tree') return null;
  for (const entry of parseTree(object.data)) if (entry.name === name) return entry.oid;
  return null;
}

// --- git data (refs) ---

function gitData(repo: Repo, method: string, tail: string[], bodyText: string): RestReply {
  if (tail[0] !== 'refs') return notFound();
  if (method === 'POST' && tail.length === 1) {
    const parsed = parseBody(bodyText);
    if ('error' in parsed) return parsed.error;
    const body = parsed.value;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return validationFailed('ref and sha are required');
    const object = getObject(sha);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) return validationFailed('sha does not name a commit or tag');
    if (repo.refs.has(ref)) {
      return { status: 422, json: { message: 'Reference already exists', errors: [{ resource: 'GitReference', code: 'custom', message: 'Reference already exists' }] } };
    }
    repo.refs.set(ref, sha);
    return ok({ ref, object: { sha, type: object.type } }, 201);
  }
  if (method === 'GET') {
    if (tail.length === 1) {
      return ok([...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } })));
    }
    const ref = `refs/${tail.slice(1).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return fail(404, 'Not Found');
    return ok({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
  }
  if (method === 'DELETE') {
    const ref = `refs/${tail.slice(1).join('/')}`;
    if (!repo.refs.delete(ref)) return fail(404, 'Not Found');
    return { status: 204 };
  }
  return notFound();
}

// --- branches ---

function branches(repo: Repo, method: string, tail: string[]): RestReply {
  if (method !== 'GET') return notFound();
  if (tail.length === 0) {
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return ok(list);
  }
  const name = tail.join('/');
  const sha = branchTip(repo, name);
  if (sha === null) return fail(404, 'Not Found');
  return ok({ name, commit: { sha }, protected: false });
}

// --- commits ---

function commits(repo: Repo, method: string, tail: string[], query: URLSearchParams, rawQuery: string, baseUrl: string): RestReply {
  if (method !== 'GET') return notFound();
  if (tail.length === 1) {
    const view = commitJson(tail[0]!);
    return view ? ok(view) : fail(404, 'Not Found');
  }
  if (tail.length > 1) return notFound();
  const shaParam = query.get('sha');
  let tip: string | null = null;
  if (shaParam === null || shaParam === '') tip = branchTip(repo, repo.headBranch);
  else if (/^[0-9a-f]{40}$/.test(shaParam) && getObject(shaParam)?.type === 'commit') tip = shaParam;
  else tip = branchTip(repo, shaParam) ?? repo.refs.get(`refs/tags/${shaParam}`) ?? null;
  if (tip === null) return fail(409, 'Git Repository is empty.');
  const all = logFrom(tip).map((oid) => commitJson(oid)!).filter(Boolean);
  const page = paginate(all, query, rawQuery, baseUrl);
  return { status: 200, json: page.items, headers: page.headers };
}

// --- labels ---

function labels(repo: Repo, method: string, tail: string[], bodyText: string): RestReply {
  if (method === 'GET' && tail.length === 0) {
    return ok([...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name)).map(labelJson));
  }
  if (method === 'POST' && tail.length === 0) {
    const parsed = parseBody(bodyText);
    if ('error' in parsed) return parsed.error;
    const body = parsed.value;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return validationFailed('name is required');
    if (repo.labels.has(name)) {
      return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name', message: 'name has already been taken' }] } };
    }
    const label: LabelRec = {
      name,
      color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.set(name, label);
    return ok(labelJson(label), 201);
  }
  if (tail.length === 1) {
    const label = repo.labels.get(decodeURIComponent(tail[0]!));
    if (!label) return fail(404, 'Not Found');
    if (method === 'GET') return ok(labelJson(label));
    if (method === 'DELETE') {
      repo.labels.delete(label.name);
      return { status: 204 };
    }
    if (method === 'PATCH') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.value.color === 'string') label.color = parsed.value.color.replace(/^#/, '');
      if (typeof parsed.value.description === 'string') label.description = parsed.value.description;
      return ok(labelJson(label));
    }
  }
  return notFound();
}

// --- issues and comments ---

function issues(repo: Repo, method: string, tail: string[], query: URLSearchParams, rawQuery: string, bodyText: string, baseUrl: string): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return validationFailed('title is required');
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
          if (name === '' || !repo.labels.has(name)) return validationFailed(`label ${JSON.stringify(name)} does not exist`);
          labelNames.push(name);
        }
      }
      const issue = createIssue(repo, { title, body: typeof body.body === 'string' ? body.body : '', labels: labelNames });
      return ok(issueJson(repo, issue), 201);
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.items.values()];
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(items, query, rawQuery, baseUrl);
      return { status: 200, json: page.items.map((item) => issueJson(repo, item)), headers: page.headers };
    }
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const item = repo.items.get(number);
  if (tail.length === 1) {
    if (!item) return fail(404, 'Not Found');
    if (method === 'GET') return ok(issueJson(repo, item));
    if (method === 'PATCH') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      const body = parsed.value;
      if (typeof body.title === 'string') item.title = body.title;
      if (typeof body.body === 'string') item.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        if (!(item.kind === 'pr' && item.merged)) item.state = body.state;
      }
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
          if (name === '' || !repo.labels.has(name)) return validationFailed(`label ${JSON.stringify(name)} does not exist`);
          names.push(name);
        }
        item.labels = names;
      }
      return ok(issueJson(repo, item));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!item) return fail(404, 'Not Found');
    if (method === 'GET') {
      const sorted = [...item.comments].sort((a, b) => a.id - b.id);
      const page = paginate(sorted, query, rawQuery, baseUrl);
      return { status: 200, json: page.items.map((comment) => commentJson(repo, item, comment)), headers: page.headers };
    }
    if (method === 'POST') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      if (body === '') return validationFailed('body is required');
      const comment = addComment(repo, item, body);
      return ok(commentJson(repo, item, comment), 201);
    }
  }
  return notFound();
}

// --- pull requests ---

function pulls(repo: Repo, method: string, tail: string[], query: URLSearchParams, rawQuery: string, bodyText: string, baseUrl: string): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      const body = parsed.value;
      const stripPrefix = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        const colon = value.indexOf(':');
        return colon >= 0 ? value.slice(colon + 1) : value;
      };
      const head = stripPrefix(body.head);
      const base = stripPrefix(body.base);
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return validationFailed('title is required');
      if (branchTip(repo, base) === null) return validationFailed(`base branch ${JSON.stringify(base)} does not exist`);
      if (branchTip(repo, head) === null) return validationFailed(`head branch ${JSON.stringify(head)} does not exist`);
      if (head === base) return validationFailed('head and base are the same');
      const existing = [...repo.items.values()].find(
        (item) => item.kind === 'pr' && item.state === 'open' && item.head === head && item.base === base,
      );
      if (existing) return validationFailed(`a pull request already exists for ${head} into ${base}`);
      const pull = createPullRequest(repo, { title, body: typeof body.body === 'string' ? body.body : '', head, base });
      return ok(issueJson(repo, pull), 201);
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(items, query, rawQuery, baseUrl);
      return { status: 200, json: page.items.map((item) => issueJson(repo, item)), headers: page.headers };
    }
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const item = repo.items.get(number);
  if (!item || item.kind !== 'pr') return fail(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(issueJson(repo, item));
    if (method === 'PATCH') {
      const parsed = parseBody(bodyText);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.value.title === 'string') item.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') item.body = parsed.value.body;
      if ((parsed.value.state === 'closed' || parsed.value.state === 'open') && !item.merged) item.state = parsed.value.state;
      return ok(issueJson(repo, item));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const changes = pullRequestChanges(repo, item);
    const page = paginate(changes, query, rawQuery, baseUrl);
    return {
      status: 200,
      json: page.items.map((change) => ({
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        sha: change.newOid ?? change.oldOid ?? ZERO_OID,
      })),
      headers: page.headers,
    };
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const parsed = parseBody(bodyText);
    if ('error' in parsed) return parsed.error;
    const methodName = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'merge';
    if (methodName !== 'merge' && methodName !== 'squash' && methodName !== 'rebase') {
      return fail(405, 'Pull Request is not mergeable');
    }
    if (item.merged || item.state !== 'open') return fail(405, 'Pull Request is not mergeable');
    const outcome = mergePullRequest(repo, item, methodName);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') return fail(405, 'Pull Request is not mergeable');
      if (outcome.reason === 'not-open') return fail(405, 'Pull Request is not mergeable');
      return fail(404, 'Not Found');
    }
    return ok({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// the entry point app.ts calls
// ---------------------------------------------------------------------------------------------

export function handleRest(
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  rawQuery: string,
  bodyText: string,
  host: string,
): RestReply {
  const baseUrl = `http://${host}/api/v3/${segments.join('/')}`;
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        json: {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === 'meta' && rest.length === 0 && method === 'GET') {
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (head === 'user' && rest.length === 0 && method === 'GET') return ok(userJson());
  if (head === 'user' && rest.length === 1 && rest[0] === 'repos') {
    if (method === 'POST') return createRepoHandler(bodyText);
    if (method === 'GET') {
      const page = paginate(listRepos(), query, rawQuery, baseUrl);
      return { status: 200, json: page.items.map(repoJson), headers: page.headers };
    }
    return notFound();
  }
  if (head === 'repos' && rest.length >= 2) {
    const repo = getRepo(rest[0]!, rest[1]!);
    if (!repo) return notFound();
    return repoRoot(repo, method, rest.slice(2), query, rawQuery, bodyText, baseUrl);
  }
  return notFound();
}
