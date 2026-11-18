// A small GraphQL v4 engine for exactly the documents gh and github-mcp-server send: queries and
// mutations with variables, aliases, inline fragments, input objects, enum lists and Relay global
// ids, plus the __type introspection probes gh feature-detects with. No library: a lexer, a parser
// and a resolver walk over the shared store in store.ts, so GraphQL and REST see the same objects.

import {
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  createPullRequest,
  getRepo,
  getRepoByDbId,
  isoAt,
  mergePullRequest,
  pullRequestChanges,
  pullRequestConflict,
  type IssueRec,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.slice(index, index + 3) === '"""') {
        const end = source.indexOf('"""', index + 3);
        tokens.push({ kind: 'string', value: source.slice(index + 3, end === -1 ? source.length : end) });
        index = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index))!;
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      index += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index))!;
      tokens.push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Map<string, Value>;
  readonly selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefaults: Map<string, Value>;
  readonly selectionSet: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, Value>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const variable = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(variable, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ type: keyword, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragmentName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragmentName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'eof') throw new Error('unterminated directive');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '}') {
        this.index += 1;
        return selections;
      }
      if (token.kind === 'spread') {
        this.index += 1;
        if (this.peek().kind === 'name' && (this.tokens[this.index] as { value?: string }).value !== 'on') {
          selections.push({ kind: 'spread', name: this.expectName() });
        } else {
          let typeCondition: string | null = null;
          if (this.peek().kind === 'name') {
            this.expectName(); // 'on'
            typeCondition = this.expectName();
          }
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = new Map<string, Value>();
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      this.skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '{') {
        selectionSet = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value token');
  }
}

function valueFromAst(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => valueFromAst(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = valueFromAst(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------------------------

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the schema: wrapped values and resolvers
// ---------------------------------------------------------------------------------------------

interface Wrapped {
  readonly __gqlType: string;
  readonly [key: string]: unknown;
}

const wrap = (type: string, fields: Record<string, unknown>): Wrapped => ({ __gqlType: type, ...fields });

interface Ctx {
  readonly errors: Array<{ message: string; path?: readonly (string | number)[] }>;
  readonly document: DocumentNode;
  readonly variables: Readonly<Record<string, unknown>>;
}

type Resolver = (source: Wrapped, args: Readonly<Record<string, unknown>>, ctx: Ctx) => unknown;

function repoOf(source: Wrapped): Repo {
  return source.repo as Repo;
}

function itemOf(source: Wrapped): IssueRec {
  return source.item as IssueRec;
}

function cursorFor(item: IssueRec): string {
  return Buffer.from(`cursor:${item.number}`, 'utf8').toString('base64');
}

interface ConnectionSlice {
  readonly page: IssueRec[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly startCursor: string | null;
  readonly total: number;
}

function sliceConnection(items: readonly IssueRec[], args: Readonly<Record<string, unknown>>): ConnectionSlice {
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const number = Number(text.replace(/^cursor:/, ''));
      const index = items.findIndex((item) => item.number === number);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 30;
  const page = items.slice(start, start + first);
  return {
    page,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length ? cursorFor(page[page.length - 1]!) : null,
    startCursor: page.length ? cursorFor(page[0]!) : null,
    total: items.length,
  };
}

function issuesOf(repo: Repo, args: Readonly<Record<string, unknown>>): IssueRec[] {
  let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    items = items.filter((item) => states.includes(item.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy ? 'DESC' : 'ASC';
  items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  return items;
}

function pullsOf(repo: Repo, args: Readonly<Record<string, unknown>>): IssueRec[] {
  let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  items = items.filter((item) => {
    const state = item.merged ? 'MERGED' : item.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(state);
  });
  items.sort((a, b) => a.number - b.number);
  return items;
}

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const userWrap = (): Wrapped => wrap('User', {});

function repoWrap(repo: Repo): Wrapped {
  return wrap('Repository', { repo });
}

function issueWrap(repo: Repo, item: IssueRec): Wrapped {
  return wrap('Issue', { repo, item });
}

function pullWrap(repo: Repo, item: IssueRec): Wrapped {
  return wrap('PullRequest', { repo, item });
}

function nodeById(id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.type === 'Repository') {
    const repo = getRepoByDbId(Number(decoded.key));
    return repo ? repoWrap(repo) : null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [dbId, number] = decoded.key.split(':').map(Number);
    const repo = getRepoByDbId(dbId ?? NaN);
    const item = repo?.items.get(number ?? NaN);
    if (!repo || !item) return null;
    return item.kind === 'pr' ? pullWrap(repo, item) : issueWrap(repo, item);
  }
  if (decoded.type === 'User') return decoded.key === VIEWER.login ? userWrap() : null;
  return null;
}

const SCHEMA: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => userWrap(),
    repository: (_source, args) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = getRepo(args.owner, args.name);
      return repo ? repoWrap(repo) : null;
    },
    node: (_source, args) => (typeof args.id === 'string' ? nodeById(args.id) : null),
    __type: (_source, args) => (typeof args.name === 'string' ? wrap('__Type', { name: args.name }) : null),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoFromGlobalId(input.repositoryId) : null;
      if (!repo) return mutationError(ctx, 'createIssue', 'repository not found');
      const issue = createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return wrap('CreateIssuePayload', { issue: issueWrap(repo, issue) });
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? itemFromGlobalId(input.issueId) : null;
      if (!found) return mutationError(ctx, 'closeIssue', 'issue not found');
      found.item.state = 'closed';
      return wrap('CloseIssuePayload', { issue: issueWrap(found.repo, found.item) });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoFromGlobalId(input.repositoryId) : null;
      if (!repo) return mutationError(ctx, 'createPullRequest', 'repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (branchTip(repo, base) === null) return mutationError(ctx, 'createPullRequest', `base branch ${base} does not exist`);
      if (branchTip(repo, head) === null) return mutationError(ctx, 'createPullRequest', `head branch ${head} does not exist`);
      const pull = createPullRequest(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, pull) });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? itemFromGlobalId(input.pullRequestId) : null;
      if (!found || found.item.kind !== 'pr') return mutationError(ctx, 'mergePullRequest', 'pull request not found');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
      const outcome = mergePullRequest(found.repo, found.item, method);
      if (!outcome.ok) return mutationError(ctx, 'mergePullRequest', outcome.reason === 'conflict' ? 'pull request is not mergeable' : 'pull request cannot be merged');
      return wrap('MergePullRequestPayload', { pullRequest: pullWrap(found.repo, found.item) });
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? itemFromGlobalId(input.subjectId) : null;
      if (!found) return mutationError(ctx, 'addComment', 'subject not found');
      const comment = addComment(found.repo, found.item, typeof input.body === 'string' ? input.body : '');
      return wrap('AddCommentPayload', {
        commentEdge: wrap('CommentEdge', { node: wrap('IssueComment', { repo: found.repo, item: found.item, comment }), cursor: '' }),
      });
    },
  },
  User: {
    id: () => globalId('User', VIEWER.login),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => '',
    avatarUrl: () => '',
  },
  Repository: {
    id: (source) => globalId('Repository', String(repoOf(source).dbId)),
    databaseId: (source) => repoOf(source).dbId,
    name: (source) => repoOf(source).name,
    nameWithOwner: (source) => `${repoOf(source).owner}/${repoOf(source).name}`,
    description: (source) => repoOf(source).description,
    isPrivate: (source) => repoOf(source).private,
    owner: () => userWrap(),
    defaultBranchRef: (source) => {
      const repo = repoOf(source);
      return branchTip(repo, repo.headBranch) !== null ? wrap('Ref', { name: repo.headBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (source) => isoAt(repoOf(source).seq),
    updatedAt: (source) => isoAt(repoOf(source).seq),
    url: () => '',
    issue: (source, args) => {
      const repo = repoOf(source);
      const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
      return item && item.kind === 'issue' ? issueWrap(repo, item) : null;
    },
    issues: (source, args) => {
      const repo = repoOf(source);
      return wrap('IssueConnection', { repo, slice: sliceConnection(issuesOf(repo, args), args) });
    },
    pullRequest: (source, args) => {
      const repo = repoOf(source);
      const item = typeof args.number === 'number' ? repo.items.get(args.number) : undefined;
      return item && item.kind === 'pr' ? pullWrap(repo, item) : null;
    },
    pullRequests: (source, args) => {
      const repo = repoOf(source);
      return wrap('PullRequestConnection', { repo, slice: sliceConnection(pullsOf(repo, args), args) });
    },
  },
  Ref: {
    name: (source) => source.name as string,
    target: () => null,
  },
  Issue: {
    id: (source) => globalId('Issue', `${repoOf(source).dbId}:${itemOf(source).number}`),
    number: (source) => itemOf(source).number,
    title: (source) => itemOf(source).title,
    body: (source) => itemOf(source).body,
    state: (source) => (itemOf(source).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => userWrap(),
    createdAt: (source) => isoAt(itemOf(source).seq),
    updatedAt: (source) => isoAt(itemOf(source).seq),
    closed: (source) => itemOf(source).state === 'closed',
    url: () => '',
    repository: (source) => repoWrap(repoOf(source)),
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', `${repoOf(source).dbId}:${itemOf(source).number}`),
    number: (source) => itemOf(source).number,
    title: (source) => itemOf(source).title,
    body: (source) => itemOf(source).body,
    state: (source) => {
      const item = itemOf(source);
      return item.merged ? 'MERGED' : item.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => itemOf(source).merged === true,
    mergedAt: (source) => {
      const item = itemOf(source);
      return item.merged && item.mergedAtSeq != null ? isoAt(item.mergedAtSeq) : null;
    },
    headRefName: (source) => itemOf(source).head ?? '',
    baseRefName: (source) => itemOf(source).base ?? '',
    mergeable: (source) => {
      const item = itemOf(source);
      if (item.merged) return 'UNKNOWN';
      return pullRequestConflict(repoOf(source), item) ? 'CONFLICTING' : 'MERGEABLE';
    },
    mergeCommit: (source) => {
      const item = itemOf(source);
      return item.mergeCommitSha ? wrap('CommitStub', { oid: item.mergeCommitSha }) : null;
    },
    author: () => userWrap(),
    createdAt: (source) => isoAt(itemOf(source).seq),
    updatedAt: (source) => isoAt(itemOf(source).seq),
    url: () => '',
    additions: (source) => pullRequestChanges(repoOf(source), itemOf(source)).reduce((sum, change) => sum + change.additions, 0),
    deletions: (source) => pullRequestChanges(repoOf(source), itemOf(source)).reduce((sum, change) => sum + change.deletions, 0),
    changedFiles: (source) => pullRequestChanges(repoOf(source), itemOf(source)).length,
    files: (source, args) => {
      const repo = repoOf(source);
      const changes = pullRequestChanges(repo, itemOf(source));
      const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : 30;
      return wrap('PullRequestChangedFileConnection', {
        nodes: changes.slice(0, first).map((change) => wrap('PullRequestChangedFile', { path: change.path })),
        total: changes.length,
      });
    },
  },
  CommitStub: {
    oid: (source) => source.oid as string,
  },
  IssueConnection: {
    nodes: (source) => {
      const slice = source.slice as ConnectionSlice;
      const repo = repoOf(source);
      return slice.page.map((item) => issueWrap(repo, item));
    },
    edges: (source) => {
      const slice = source.slice as ConnectionSlice;
      const repo = repoOf(source);
      return slice.page.map((item) => wrap('IssueEdge', { node: issueWrap(repo, item), cursor: cursorFor(item) }));
    },
    pageInfo: (source) => pageInfoWrap(source.slice as ConnectionSlice),
    totalCount: (source) => (source.slice as ConnectionSlice).total,
  },
  PullRequestConnection: {
    nodes: (source) => {
      const slice = source.slice as ConnectionSlice;
      const repo = repoOf(source);
      return slice.page.map((item) => pullWrap(repo, item));
    },
    edges: (source) => {
      const slice = source.slice as ConnectionSlice;
      const repo = repoOf(source);
      return slice.page.map((item) => wrap('PullRequestEdge', { node: pullWrap(repo, item), cursor: cursorFor(item) }));
    },
    pageInfo: (source) => pageInfoWrap(source.slice as ConnectionSlice),
    totalCount: (source) => (source.slice as ConnectionSlice).total,
  },
  IssueEdge: {
    node: (source) => source.node as Wrapped,
    cursor: (source) => source.cursor as string,
  },
  PullRequestEdge: {
    node: (source) => source.node as Wrapped,
    cursor: (source) => source.cursor as string,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    hasPreviousPage: (source) => source.hasPreviousPage as boolean,
    startCursor: (source) => (source.startCursor as string | null) ?? null,
    endCursor: (source) => (source.endCursor as string | null) ?? null,
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source.nodes as Wrapped[],
    totalCount: (source) => source.total as number,
  },
  PullRequestChangedFile: {
    path: (source) => source.path as string,
  },
  IssueComment: {
    id: (source) => {
      const comment = source.comment as { id: number };
      return globalId('IssueComment', `${repoOf(source).dbId}:${itemOf(source).number}:${comment.id}`);
    },
    body: (source) => (source.comment as { body: string }).body,
    author: () => userWrap(),
    createdAt: (source) => isoAt((source.comment as { seq: number }).seq),
  },
  CommentEdge: {
    node: (source) => source.node as Wrapped,
    cursor: (source) => source.cursor as string,
  },
  CreateIssuePayload: {
    issue: (source) => source.issue as Wrapped,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue as Wrapped,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Wrapped,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest as Wrapped,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge as Wrapped,
    clientMutationId: () => null,
  },
  __Type: {
    name: (source) => source.name as string,
    kind: (source) => (ENUMS[source.name as string] ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (source) => {
      const name = source.name as string;
      if (ENUMS[name]) return null;
      const fields = SCHEMA[name];
      if (!fields) return null;
      return Object.keys(fields).map((fieldName) => wrap('__Field', { name: fieldName }));
    },
    enumValues: (source) => {
      const values = ENUMS[source.name as string];
      return values ? values.map((value) => wrap('__EnumValue', { name: value })) : null;
    },
    possibleTypes: () => null,
  },
  __Field: {
    name: (source) => source.name as string,
    description: () => null,
  },
  __EnumValue: {
    name: (source) => source.name as string,
    description: () => null,
  },
};

function pageInfoWrap(slice: ConnectionSlice): Wrapped {
  return wrap('PageInfo', {
    hasNextPage: slice.hasNextPage,
    hasPreviousPage: false,
    startCursor: slice.startCursor,
    endCursor: slice.endCursor,
  });
}

function repoFromGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  return getRepoByDbId(Number(decoded.key));
}

function itemFromGlobalId(id: string): { repo: Repo; item: IssueRec } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || (decoded.type !== 'Issue' && decoded.type !== 'PullRequest' && decoded.type !== 'IssueComment')) return null;
  const [dbId, number] = decoded.key.split(':').map(Number);
  const repo = getRepoByDbId(dbId ?? NaN);
  const item = repo?.items.get(number ?? NaN);
  return repo && item ? { repo, item } : null;
}

function mutationError(ctx: Ctx, field: string, message: string): null {
  ctx.errors.push({ message, path: [field] });
  return null;
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

function executeSelectionSet(typeName: string, source: Wrapped, selections: readonly SelectionNode[], ctx: Ctx, path: readonly (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeResolvers = SCHEMA[typeName] ?? {};
  const runSelections = (list: readonly SelectionNode[], currentPath: readonly (string | number)[]): void => {
    for (const selection of list) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition === null || selection.typeCondition === typeName) runSelections(selection.selectionSet, currentPath);
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = ctx.document.fragments.get(selection.name);
        if (fragment && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
          runSelections(fragment.selectionSet, currentPath);
        }
        continue;
      }
      const responseKey = selection.alias ?? selection.name;
      const fieldPath = [...currentPath, responseKey];
      if (selection.name === '__typename') {
        out[responseKey] = typeName;
        continue;
      }
      const resolver = typeResolvers[selection.name];
      if (!resolver) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const [argName, argValue] of selection.args) args[argName] = valueFromAst(argValue, ctx.variables);
      let value: unknown;
      try {
        value = resolver(source, args, ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
        value = null;
      }
      out[responseKey] = completeValue(value, selection, ctx, fieldPath);
    }
  };
  runSelections(selections, path);
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx, path: readonly (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(entry, field, ctx, [...path, index]));
  }
  if (typeof value === 'object' && '__gqlType' in (value as Record<string, unknown>)) {
    const wrapped = value as Wrapped;
    if (!field.selectionSet) return null;
    return executeSelectionSet(wrapped.__gqlType, wrapped, field.selectionSet, ctx, path);
  }
  return value;
}

function executeOperation(document: DocumentNode, operationName: string | null, variables: Readonly<Record<string, unknown>>): { data: Record<string, unknown>; errors: Ctx['errors'] } {
  const operation = operationName !== null ? document.operations.find((op) => op.name === operationName) : document.operations[0];
  if (!operation) throw new Error('no operation to execute');
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of operation.variableDefaults) {
    if (mergedVariables[name] === undefined) mergedVariables[name] = valueFromAst(defaultValue, mergedVariables);
  }
  const ctx: Ctx = { errors: [], document, variables: mergedVariables };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, wrap(rootType, {}), operation.selectionSet, ctx, []);
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------------------------------------
// the HTTP entry point app.ts calls
// ---------------------------------------------------------------------------------------------

export interface GraphQLReply {
  readonly status: number;
  readonly json: unknown;
}

function executeOne(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  if (query === '') return { errors: [{ message: 'query is required' }] };
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Syntax Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  try {
    const { data, errors } = executeOperation(document, operationName, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length) out.errors = errors;
    return out;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphQL(bodyText: string): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOne(entry as Record<string, unknown>) : { errors: [{ message: 'invalid operation' }] },
    );
    return { status: 200, json: results };
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 400, json: { message: 'Problems parsing JSON' } };
  return { status: 200, json: executeOne(parsed as Record<string, unknown>) };
}
