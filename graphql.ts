// GraphQL v4 surface: a small parser + executor for the document shapes gh and
// github-mcp-server send (queries, mutations, variables, inline enums/input objects,
// inline fragments, __type introspection, operation batching). No GraphQL library.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  nowIso,
  threeWayMerge,
  findMergeBase,
  branchFilesAt,
  diffFiles,
  commitFiles,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// global ids: opaque, stable, decodable (base64 of "kind:repoId:number")
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, repoId: number, num: number): string {
  return Buffer.from(`${kind}:${repoId}:${num}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const repoId = parseInt(parts[1]!, 10);
    const num = parseInt(parts[2]!, 10);
    if (!Number.isInteger(repoId) || !Number.isInteger(num)) return null;
    return { kind: parts[0]!, repoId, num };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', repo.id, 0);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('I', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PR', repo.id, pull.number);
}

// -------------------------------------------------------------------------------------------
// tokenizer + parser (the document subset the checks send)
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&()[]{}:=@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: { name: string; type: string; defaultValue: ValueNode | null }[];
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    return this.tokens[this.pos++]!;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value as string;
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { kind, name, variableDefinitions, selectionSet };
  }

  parseType(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (token.kind !== 'name') throw new Error('expected a type in GraphQL document');
    let out = token.value;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (this.peek().kind === 'name') {
        throw new Error('named fragments are not supported');
      }
      return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueFromNode(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsFromNodes(nodes: { name: string; value: ValueNode }[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of nodes) out[arg.name] = valueFromNode(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// schema (for validation and __type introspection)
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments', 'author', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt', 'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  Ref: ['name'],
  __Type: ['name', 'fields', 'enumValues', 'kind'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const SCHEMA_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The GraphQL type a field resolves to, for validation of nested selections. */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
};

// -------------------------------------------------------------------------------------------
// values
// -------------------------------------------------------------------------------------------

type GqlValue =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; files: { path: string }[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'Ref'; name: string }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; comment: { id: string; body: string } }
  | { __typename: 'IssueCommentEdge'; comment: { id: string; body: string } }
  | { __typename: 'IssueComment'; id: string; body: string }
  | null;

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  return threeWayMerge(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let items = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy !== undefined && typeof orderBy === 'object') {
    const field = orderBy.field ?? 'CREATED_AT';
    const direction = orderBy.direction === 'ASC' ? 1 : -1;
    items.sort((a, b) => {
      let cmp = 0;
      if (field === 'UPDATED_AT') cmp = a.updated_at.localeCompare(b.updated_at);
      else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
      else cmp = a.created_at.localeCompare(b.created_at);
      if (cmp === 0) cmp = a.number - b.number;
      return cmp * direction;
    });
  } else {
    items.sort((a, b) => a.number - b.number);
  }
  const afterIndex = decodeCursor(args.after as string | null | undefined);
  const start = afterIndex + 1;
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : items.length;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : null;
  return {
    __typename: 'IssueConnection',
    repo,
    issues: page,
    pageInfo: { hasNextPage, endCursor },
  };
}

function pullFilesConnection(repo: Repo, pull: Pull, first: number): GqlValue {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const mergeBase = findMergeBase(repo, baseTip, headTip);
  const ancestorFiles = mergeBase === null ? new Map() : branchFilesAt(repo, mergeBase);
  const headFiles = branchFilesAt(repo, headTip);
  const files = diffFiles(ancestorFiles, headFiles, repo).map((f) => ({ path: f.filename }));
  return { __typename: 'PullRequestChangedFileConnection', files: files.slice(0, first) };
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

class GraphQLError extends Error {}

function validateSelections(typeName: string, selections: SelectionNode[], errors: string[]): void {
  const fields = SCHEMA_FIELDS[typeName];
  if (fields === undefined) return; // unknown type (e.g. Node union): fragments carry the check
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const target = selection.typeCondition ?? typeName;
      validateSelections(target, selection.selectionSet, errors);
      continue;
    }
    if (!fields.includes(selection.name)) {
      errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
      continue;
    }
    if (selection.selectionSet !== null) {
      const childType = FIELD_TYPE[typeName]?.[selection.name];
      if (childType !== undefined && childType !== 'Node') {
        validateSelections(childType, selection.selectionSet, errors);
      }
    }
  }
}

function resolveField(
  store: Store,
  value: GqlValue,
  field: FieldNode,
  variables: Record<string, unknown>,
): unknown {
  if (value === null) return null;
  const args = argsFromNodes(field.args, variables);
  switch (value.__typename) {
    case 'User':
      return field.name === 'login' ? value.login : null;
    case 'Repository': {
      const repo = value.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __typename: 'User', login: repo.owner } as GqlValue;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ __typename: 'Ref', name: repo.defaultBranch } as GqlValue);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const num = args.number as number;
          const issue = repo.issues.find((i) => i.number === num);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlValue);
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequests': {
          const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : repo.pulls.length;
          return { __typename: 'PullRequestConnection', repo, pulls: [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first) } as GqlValue;
        }
        case 'pullRequest': {
          const num = args.number as number;
          const pull = repo.pulls.find((p) => p.number === num);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlValue);
        }
        default: return null;
      }
    }
    case 'Issue': {
      switch (field.name) {
        case 'id': return issueGlobalId(value.repo, value.issue);
        case 'number': return value.issue.number;
        case 'title': return value.issue.title;
        case 'state': return issueState(value.issue);
        case 'body': return value.issue.body;
        case 'createdAt': return value.issue.created_at;
        case 'updatedAt': return value.issue.updated_at;
        default: return null;
      }
    }
    case 'IssueConnection': {
      switch (field.name) {
        case 'nodes': return value.issues.map((issue) => ({ __typename: 'Issue', repo: value.repo, issue }) as GqlValue);
        case 'pageInfo': return { __typename: 'PageInfo', hasNextPage: value.pageInfo.hasNextPage, endCursor: value.pageInfo.endCursor } as GqlValue;
        case 'totalCount': return value.issues.length;
        default: return null;
      }
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return value.hasNextPage;
      if (field.name === 'endCursor') return value.endCursor;
      return null;
    }
    case 'PullRequest': {
      switch (field.name) {
        case 'id': return pullGlobalId(value.repo, value.pull);
        case 'number': return value.pull.number;
        case 'title': return value.pull.title;
        case 'body': return value.pull.body;
        case 'state': return pullState(value.pull);
        case 'merged': return value.pull.merged;
        case 'headRefName': return value.pull.head.ref;
        case 'baseRefName': return value.pull.base.ref;
        case 'mergeable': return pullMergeable(value.repo, value.pull);
        case 'files': {
          const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 10;
          return pullFilesConnection(value.repo, value.pull, first);
        }
        case 'createdAt': return value.pull.created_at;
        case 'updatedAt': return value.pull.updated_at;
        default: return null;
      }
    }
    case 'PullRequestConnection': {
      switch (field.name) {
        case 'nodes': return value.pulls.map((pull) => ({ __typename: 'PullRequest', repo: value.repo, pull }) as GqlValue);
        case 'pageInfo': return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as GqlValue;
        case 'totalCount': return value.pulls.length;
        default: return null;
      }
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return value.files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path }) as GqlValue);
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as GqlValue;
      return null;
    }
    case 'PullRequestChangedFile':
      return field.name === 'path' ? value.path : null;
    case 'Ref':
      return field.name === 'name' ? value.name : null;
    case '__Type': {
      if (field.name === 'name') return value.name;
      if (field.name === 'fields') {
        if (SCHEMA_ENUM_VALUES[value.name] !== undefined) return null;
        return (SCHEMA_FIELDS[value.name] ?? []).map((name) => ({ __typename: '__Field', name }) as GqlValue);
      }
      if (field.name === 'enumValues') {
        const values = SCHEMA_ENUM_VALUES[value.name];
        if (values === undefined) return null;
        return values.map((name) => ({ __typename: '__EnumValue', name }) as GqlValue);
      }
      if (field.name === 'kind') return SCHEMA_ENUM_VALUES[value.name] !== undefined ? 'ENUM' : 'OBJECT';
      return null;
    }
    case '__Field':
      return field.name === 'name' ? value.name : null;
    case '__EnumValue':
      return field.name === 'name' ? value.name : null;
    case 'CreateIssuePayload':
      return field.name === 'issue' ? ({ __typename: 'Issue', repo: value.repo, issue: value.issue } as GqlValue) : null;
    case 'CloseIssuePayload':
      return field.name === 'issue' ? ({ __typename: 'Issue', repo: value.repo, issue: value.issue } as GqlValue) : null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field.name === 'pullRequest' ? ({ __typename: 'PullRequest', repo: value.repo, pull: value.pull } as GqlValue) : null;
    case 'AddCommentPayload':
      return field.name === 'commentEdge' ? ({ __typename: 'IssueCommentEdge', comment: value.comment } as GqlValue) : null;
    case 'IssueCommentEdge':
      return field.name === 'node' ? ({ __typename: 'IssueComment', id: value.comment.id, body: value.comment.body } as GqlValue) : null;
    case 'IssueComment':
      if (field.name === 'id') return value.id;
      if (field.name === 'body') return value.body;
      return null;
    default:
      return null;
  }
}

function resolveSelections(
  store: Store,
  value: GqlValue,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && value !== null && value.__typename !== selection.typeCondition) continue;
      Object.assign(out, resolveSelections(store, value, selection.selectionSet, variables));
      continue;
    }
    const fieldValue = resolveField(store, value, selection, variables);
    const key = selection.alias ?? selection.name;
    if (selection.selectionSet === null || fieldValue === null || typeof fieldValue !== 'object') {
      out[key] = fieldValue;
    } else if (Array.isArray(fieldValue)) {
      out[key] = fieldValue.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? resolveSelections(store, item as GqlValue, selection.selectionSet!, variables)
          : item,
      );
    } else if ('__typename' in (fieldValue as Record<string, unknown>)) {
      out[key] = resolveSelections(store, fieldValue as GqlValue, selection.selectionSet, variables);
    } else {
      out[key] = fieldValue;
    }
  }
  return out;
}

function resolveRootQuery(store: Store, field: FieldNode, variables: Record<string, unknown>): GqlValue {
  const args = argsFromNodes(field.args, variables);
  switch (field.name) {
    case 'viewer':
      return { __typename: 'User', login: VIEWER.login };
    case 'repository': {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : { __typename: 'Repository', repo };
    }
    case 'node': {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      const repo = findRepoById(store, decoded.repoId);
      if (repo === undefined) return null;
      if (decoded.kind === 'R') return { __typename: 'Repository', repo };
      if (decoded.kind === 'I') {
        const issue = repo.issues.find((i) => i.number === decoded.num);
        return issue === undefined ? null : { __typename: 'Issue', repo, issue };
      }
      if (decoded.kind === 'PR') {
        const pull = repo.pulls.find((p) => p.number === decoded.num);
        return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
      }
      return null;
    }
    case '__type': {
      const name = args.name as string;
      if (SCHEMA_FIELDS[name] === undefined && SCHEMA_ENUM_VALUES[name] === undefined) return null;
      return { __typename: '__Type', name };
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
  }
}

function resolveRootMutation(store: Store, field: FieldNode, variables: Record<string, unknown>): GqlValue {
  const args = argsFromNodes(field.args, variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'R') throw new GraphQLError('createIssue: unknown repositoryId');
      const repo = findRepoById(store, decoded.repoId);
      if (repo === undefined) throw new GraphQLError('createIssue: unknown repositoryId');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GraphQLError('createIssue: title is required');
      repo.seq += 1;
      const issue: Issue = {
        id: repo.seq,
        number: repo.seq,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        user: { login: VIEWER.login },
        created_at: nowIso(),
        updated_at: nowIso(),
        comments: [],
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', repo, issue };
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'I') throw new GraphQLError('closeIssue: unknown issueId');
      const repo = findRepoById(store, decoded.repoId);
      const issue = repo?.issues.find((i) => i.number === decoded.num);
      if (repo === undefined || issue === undefined) throw new GraphQLError('closeIssue: unknown issueId');
      issue.state = 'closed';
      issue.updated_at = nowIso();
      return { __typename: 'CloseIssuePayload', repo, issue };
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'R') throw new GraphQLError('createPullRequest: unknown repositoryId');
      const repo = findRepoById(store, decoded.repoId);
      if (repo === undefined) throw new GraphQLError('createPullRequest: unknown repositoryId');
      const base = String(input.baseRefName ?? '');
      const head = String(input.headRefName ?? '');
      const title = typeof input.title === 'string' ? input.title : '';
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) throw new GraphQLError('createPullRequest: head or base branch does not exist');
      repo.seq += 1;
      const pull: Pull = {
        number: repo.seq,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: head, sha: headTip, label: `${repo.owner}:${head}` },
        base: { ref: base, sha: baseTip, label: `${repo.owner}:${base}` },
        user: { login: VIEWER.login },
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', repo, pull };
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PR') throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      const repo = findRepoById(store, decoded.repoId);
      const pull = repo?.pulls.find((p) => p.number === decoded.num);
      if (repo === undefined || pull === undefined) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      if (pull.merged || pull.state !== 'open') throw new GraphQLError('mergePullRequest: pull request is not open');
      const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      if (headTip === undefined || baseTip === undefined) throw new GraphQLError('mergePullRequest: head or base branch does not exist');
      const mergedFiles = threeWayMerge(repo, baseTip, headTip);
      if (mergedFiles === null) throw new GraphQLError('mergePullRequest: merge conflict');
      const mergeCommit = commitFiles(repo, pull.base.ref, mergedFiles, `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`);
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = nowIso();
      pull.merge_commit_sha = mergeCommit;
      pull.updated_at = nowIso();
      return { __typename: 'MergePullRequestPayload', repo, pull };
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'I') throw new GraphQLError('addComment: unknown subjectId');
      const repo = findRepoById(store, decoded.repoId);
      const issue = repo?.issues.find((i) => i.number === decoded.num);
      if (repo === undefined || issue === undefined) throw new GraphQLError('addComment: unknown subjectId');
      const body = typeof input.body === 'string' ? input.body : '';
      if (body === '') throw new GraphQLError('addComment: body is required');
      repo.commentSeq += 1;
      const comment = {
        id: repo.commentSeq,
        body,
        user: { login: VIEWER.login },
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        comment: { id: encodeGlobalId('C', repo.id, comment.id), body },
      };
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(rootType, operation.selectionSet, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  try {
    const data: Record<string, unknown> = {};
    for (const selection of operation.selectionSet) {
      if (selection.kind === 'fragment') continue; // fragments cannot appear at the root
      const rootValue = operation.kind === 'mutation'
        ? resolveRootMutation(store, selection, variables)
        : resolveRootQuery(store, selection, variables);
      const key = selection.alias ?? selection.name;
      if (selection.selectionSet === null || rootValue === null) {
        data[key] = rootValue;
      } else {
        data[key] = resolveSelections(store, rootValue, selection.selectionSet, variables);
      }
    }
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { data: null, errors: [{ message: 'method not allowed' }] });
    return;
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (token === '' ? !(header.startsWith('Bearer ') && header.slice(7).length > 0) : header !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { data: null, errors: [{ message: 'request body is not valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const op = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'request has no query string' }] };
    }
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(op.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    const variables = (op.variables ?? {}) as Record<string, unknown>;
    let operation: OperationNode | undefined;
    if (typeof op.operationName === 'string') {
      operation = operations.find((o) => o.name === op.operationName);
      if (operation === undefined) {
        return { data: null, errors: [{ message: `unknown operation "${op.operationName}"` }] };
      }
    } else {
      operation = operations[0];
    }
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'document has no operation' }] };
    }
    return executeOperation(store, operation, variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
