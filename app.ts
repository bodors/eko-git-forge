// HTTP server + GitHub REST v3 surface. One in-memory Store is shared with the git,
// GraphQL and MCP handlers (same objects, same ids, across every surface).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  VIEWER_IDENTITY,
  ZERO_OID,
  hashObject,
  putBlob,
  branchFiles,
  branchFilesAt,
  commitFiles,
  flattenTree,
  listCommits,
  parseCommit,
  parseTree,
  isAncestor,
  threeWayMerge,
  findMergeBase,
  diffFiles,
  nowIso,
  nowSec,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BASE_BRANCH = 'main';

let requestCounter = 0;

function requestId(): string {
  // A plain counter: no unseeded randomness, so a live pass and its replay answer identically.
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (TOKEN === '') return header.startsWith('Bearer ') && header.slice(7).length > 0;
  return header === `Bearer ${TOKEN}`;
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams;
}

function pageParams(req: IncomingMessage): { page: number; perPage: number } {
  const q = queryOf(req);
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

function linkHeader(req: IncomingMessage, path: string, page: number, perPage: number, totalPages: number): string {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  return links.join(', ');
}

// -------------------------------------------------------------------------------------------
// REST shapes
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`R_${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: '',
    language: null,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`I_${repo.id}_${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '', default: false })),
    user: { login: issue.user.login, id: VIEWER.id, type: 'User' },
    assignees: [],
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: Buffer.from(`PR_${repo.id}_${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label, user: { login: repo.owner, id: VIEWER.id } },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label, user: { login: repo.owner, id: VIEWER.id } },
    user: { login: pull.user.login, id: VIEWER.id, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    draft: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
  };
}

function errJson(message: string): Record<string, unknown> {
  return { message };
}

// -------------------------------------------------------------------------------------------
// git object helpers shared by REST contents/commits
// -------------------------------------------------------------------------------------------

function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj?.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const stamp = new Date(view.timestamp * 1000).toISOString();
  const authorName = view.author.replace(/ <.*$/, '');
  const authorEmail = (/<(.*)>/.exec(view.author) ?? [])[1] ?? '';
  return {
    sha: oid,
    node_id: Buffer.from(`C_${oid}`).toString('base64'),
    commit: {
      message: view.message,
      author: { name: authorName, email: authorEmail, date: stamp },
      committer: { name: authorName, email: authorEmail, date: stamp },
      tree: { sha: view.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: view.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

// -------------------------------------------------------------------------------------------
// request routing + REST handlers
// -------------------------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, store: Store, params: Record<string, string>, body: unknown) => void;

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function resolveRefCommit(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  const tagTip = repo.refs.get(`refs/tags/${ref}`);
  if (tagTip !== undefined) return tagTip;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj?.type === 'commit') return ref;
  }
  return null;
}

function contentsEntries(repo: Repo, commitOid: string, dirPath: string): Record<string, unknown>[] | null {
  const commit = repo.objects.get(commitOid);
  if (commit?.type !== 'commit') return null;
  const files = flattenTree(repo.objects, parseCommit(commit.data).tree);
  if (dirPath === '') {
    // top-level directory: list immediate children
    const children = new Map<string, { type: string; sha: string; size: number }>();
    const treeObj = repo.objects.get(parseCommit(commit.data).tree);
    if (treeObj?.type !== 'tree') return null;
    for (const entry of parseTree(treeObj.data)) {
      children.set(entry.name, {
        type: entry.mode === '40000' ? 'dir' : 'file',
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : blobSize(repo, entry.oid),
      });
    }
    return [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, v]) => ({
      type: v.type,
      name,
      path: name,
      sha: v.sha,
      size: v.size,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${name}`,
    }));
  }
  const entry = files.get(dirPath);
  if (entry !== undefined) return null; // it is a file, not a directory
  // is dirPath a directory prefix?
  const prefix = `${dirPath}/`;
  const children = new Map<string, { type: string; sha: string; size: number }>();
  for (const [path, value] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (rest.includes('/')) {
      // intermediate directory: find its tree oid by walking the tree
      const treeOid = treeOidAtPath(repo, commitOid, `${dirPath}/${first}`);
      if (treeOid !== null) children.set(first, { type: 'dir', sha: treeOid, size: 0 });
    } else {
      children.set(first, { type: 'file', sha: value.oid, size: blobSize(repo, value.oid) });
    }
  }
  if (children.size === 0) return null;
  return [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, v]) => ({
    type: v.type,
    name,
    path: `${dirPath}/${name}`,
    sha: v.sha,
    size: v.size,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${dirPath}/${name}`,
  }));
}

function treeOidAtPath(repo: Repo, commitOid: string, dirPath: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (commit?.type !== 'commit') return null;
  let current = parseCommit(commit.data).tree;
  for (const seg of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (obj?.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function blobSize(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  return obj?.type === 'blob' ? obj.data.length : 0;
}

function fileContentJson(repo: Repo, commitOid: string, path: string): Record<string, unknown> | null {
  const files = branchFilesAt(repo, commitOid);
  const entry = files.get(path);
  if (entry === undefined) return null;
  const obj = repo.objects.get(entry.oid);
  if (obj?.type !== 'blob') return null;
  return {
    type: 'file',
    encoding: 'base64',
    size: obj.data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: obj.data.toString('base64'),
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, pathname: string): Promise<void> {
  const method = req.method ?? 'GET';
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    sendJson(res, 400, errJson('Problems parsing JSON'));
    return;
  }
  const body = parsed.value as Record<string, unknown> | undefined;

  if (!authed(req)) {
    sendJson(res, 401, errJson('Bad credentials'));
    return;
  }

  const segments = pathname.split('/').filter((s) => s.length > 0).map(decodeSegment);
  // segments[0] = 'api', [1] = 'v3'
  const rest = segments.slice(2);

  // API root
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
      meta: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }

  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      sendJson(res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        site_admin: false,
      });
      return;
    }
    if (rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(req);
        const repos = store.listRepos(VIEWER.login);
        const { slice, totalPages } = paginate(repos, page, perPage);
        sendJson(res, 200, slice.map(repoJson), { link: linkHeader(req, pathname, page, perPage, totalPages) });
        return;
      }
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') {
          sendJson(res, 422, errJson('name is required'));
          return;
        }
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          // GitHub's wording: the git client treats a 422 carrying "already exists"
          // as an idempotent re-create, so keep that phrase in the message.
          sendJson(res, 422, errJson('name already exists on this account'));
          return;
        }
        const repo = store.createRepo(VIEWER.login, name, {
          description: typeof body?.description === 'string' ? body.description : '',
          private: body?.private === true,
        });
        sendJson(res, 201, repoJson(repo));
        return;
      }
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    sendJson(res, 404, errJson('Not Found'));
    return;
  }
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, errJson('Not Found'));
    return;
  }
  const sub = rest.slice(3);

  // /repos/{o}/{r}
  if (sub.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (body?.private === true || body?.private === false) repo.private = body.private;
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // branches
  if (sub[0] === 'branches') {
    if (method === 'GET' && sub.length === 1) {
      const out = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, commit: { message: commitMessage(repo, sha) } },
          protected: false,
        }));
      sendJson(res, 200, out);
      return;
    }
    if (method === 'GET' && sub.length === 2) {
      const tip = repo.refs.get(`refs/heads/${sub[1]}`);
      if (tip === undefined) {
        sendJson(res, 404, errJson('Branch not found'));
        return;
      }
      sendJson(res, 200, {
        name: sub[1],
        commit: { sha: tip, commit: { message: commitMessage(repo, tip) } },
        protected: false,
      });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // commits
  if (sub[0] === 'commits') {
    if (method === 'GET' && sub.length === 1) {
      const shaParam = queryOf(req).get('sha');
      const tip = resolveRefCommit(repo, shaParam);
      if (tip === null) {
        sendJson(res, 404, errJson('No commit found for SHA'));
        return;
      }
      const { page, perPage } = pageParams(req);
      const commits = listCommits(repo.objects, tip);
      const { slice, totalPages } = paginate(commits, page, perPage);
      const out: Record<string, unknown>[] = [];
      for (const oid of slice) {
        const c = commitJson(repo, oid);
        if (c !== null) out.push(c);
      }
      sendJson(res, 200, out, { link: linkHeader(req, pathname, page, perPage, totalPages) });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // git refs
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (method === 'GET') {
      const refSuffix = sub.slice(2).join('/');
      if (refSuffix === '') {
        const out = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          node_id: Buffer.from(`R_${ref}`).toString('base64'),
          url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`,
          object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
        }));
        sendJson(res, 200, out);
        return;
      }
      const ref = `refs/${refSuffix}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      sendJson(res, 200, {
        ref,
        node_id: Buffer.from(`R_${ref}`).toString('base64'),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refSuffix}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
      return;
    }
    if (method === 'POST' && sub.length === 2) {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || repo.objects.get(sha) === undefined) {
        sendJson(res, 422, errJson('Invalid ref or sha'));
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, errJson('Reference already exists'));
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, {
        ref,
        node_id: Buffer.from(`R_${ref}`).toString('base64'),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // contents
  if (sub[0] === 'contents') {
    const contentPath = sub.slice(1).join('/');
    const refParam = queryOf(req).get('ref');
    if (method === 'GET') {
      if (contentPath === '') {
        const tip = resolveRefCommit(repo, refParam);
        if (tip === null) {
          sendJson(res, 404, errJson('Not Found'));
          return;
        }
        const entries = contentsEntries(repo, tip, '');
        sendJson(res, 200, entries ?? []);
        return;
      }
      const tip = resolveRefCommit(repo, refParam);
      if (tip === null) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      const file = fileContentJson(repo, tip, contentPath);
      if (file !== null) {
        sendJson(res, 200, file);
        return;
      }
      const entries = contentsEntries(repo, tip, contentPath);
      if (entries !== null) {
        sendJson(res, 200, entries);
        return;
      }
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    if (method === 'PUT') {
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const message = typeof body?.message === 'string' ? body.message : `Update ${contentPath}`;
      const content = typeof body?.content === 'string' ? body.content : '';
      const givenSha = typeof body?.sha === 'string' ? body.sha : undefined;
      if (content === '') {
        sendJson(res, 422, errJson('content is required'));
        return;
      }
      let decoded: Buffer;
      try {
        decoded = Buffer.from(content.replace(/\s/g, ''), 'base64');
      } catch {
        sendJson(res, 422, errJson('content is not valid base64'));
        return;
      }
      const files = branchFiles(repo, branch);
      const existing = files.get(contentPath);
      if (existing !== undefined) {
        if (givenSha === undefined || givenSha !== existing.oid) {
          sendJson(res, 409, errJson('sha does not match the current blob'));
          return;
        }
      }
      const blobOid = putBlob(repo, decoded);
      files.set(contentPath, { oid: blobOid, mode: '100644' });
      const commitOid = commitFiles(repo, branch, files, message);
      sendJson(res, existing === undefined ? 201 : 200, {
        content: {
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          sha: blobOid,
          size: decoded.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const message = typeof body?.message === 'string' ? body.message : `Delete ${contentPath}`;
      const givenSha = typeof body?.sha === 'string' ? body.sha : undefined;
      const files = branchFiles(repo, branch);
      const existing = files.get(contentPath);
      if (existing === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (givenSha !== undefined && givenSha !== existing.oid) {
        sendJson(res, 409, errJson('sha does not match the current blob'));
        return;
      }
      files.delete(contentPath);
      const commitOid = commitFiles(repo, branch, files, message);
      sendJson(res, 200, {
        commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // labels
  if (sub[0] === 'labels') {
    if (method === 'GET' && sub.length === 1) {
      sendJson(res, 200, repo.labels.map((l) => ({ name: l.name, color: l.color, description: '', default: false })));
      return;
    }
    if (method === 'POST' && sub.length === 1) {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, errJson('name is required'));
        return;
      }
      if (repo.labels.some((l) => l.name === name)) {
        sendJson(res, 422, errJson('Label already exists'));
        return;
      }
      const color = typeof body?.color === 'string' ? body.color : 'ededed';
      repo.labels.push({ name, color });
      sendJson(res, 201, { name, color, description: '', default: false });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // issues
  if (sub[0] === 'issues') {
    if (sub.length === 1) {
      if (method === 'GET') {
        const q = queryOf(req);
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'desc';
        let items = [...repo.issues];
        if (state !== 'all') items = items.filter((i) => i.state === state);
        if (sort === 'created') {
          items.sort((a, b) => {
            const cmp = direction === 'asc' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at);
            return cmp !== 0 ? cmp : direction === 'asc' ? a.number - b.number : b.number - a.number;
          });
        }
        const { page, perPage } = pageParams(req);
        const { slice, totalPages } = paginate(items, page, perPage);
        sendJson(res, 200, slice.map((i) => issueJson(repo, i)), { link: linkHeader(req, pathname, page, perPage, totalPages) });
        return;
      }
      if (method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        if (title === '') {
          sendJson(res, 422, errJson('title is required'));
          return;
        }
        const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name)).filter((n): n is string => typeof n === 'string') : [];
        const labels: { name: string; color: string }[] = [];
        for (const name of labelNames) {
          const found = repo.labels.find((l) => l.name === name);
          if (found === undefined) {
            sendJson(res, 422, errJson(`Label does not exist: ${name}`));
            return;
          }
          labels.push(found);
        }
        repo.seq += 1;
        const issue: Issue = {
          id: repo.seq,
          number: repo.seq,
          title,
          body: typeof body?.body === 'string' ? body.body : '',
          state: 'open',
          labels,
          user: { login: VIEWER.login },
          created_at: nowIso(),
          updated_at: nowIso(),
          comments: [],
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    const num = parseInt(sub[1]!, 10);
    const issue = repo.issues.find((i) => i.number === num);
    if (sub.length === 2) {
      if (issue === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        issue.updated_at = nowIso();
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    if (sub[2] === 'comments') {
      if (issue === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          user: { login: c.user.login },
          created_at: c.created_at,
          updated_at: c.updated_at,
        })));
        return;
      }
      if (method === 'POST') {
        const commentBody = typeof body?.body === 'string' ? body.body : '';
        if (commentBody === '') {
          sendJson(res, 422, errJson('body is required'));
          return;
        }
        repo.commentSeq += 1;
        const comment = {
          id: repo.commentSeq,
          body: commentBody,
          user: { login: VIEWER.login },
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        issue.comments.push(comment);
        sendJson(res, 201, comment);
        return;
      }
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  // pulls
  if (sub[0] === 'pulls') {
    if (sub.length === 1) {
      if (method === 'GET') {
        const state = queryOf(req).get('state') ?? 'open';
        let items = [...repo.pulls];
        if (state !== 'all') items = items.filter((p) => p.state === state);
        const { page, perPage } = pageParams(req);
        const { slice, totalPages } = paginate(items, page, perPage);
        sendJson(res, 200, slice.map((p) => pullJson(repo, p)), { link: linkHeader(req, pathname, page, perPage, totalPages) });
        return;
      }
      if (method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        const headRaw = typeof body?.head === 'string' ? body.head : '';
        const baseRaw = typeof body?.base === 'string' ? body.base : '';
        const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
        const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
        if (title === '' || head === '' || base === '') {
          sendJson(res, 422, errJson('title, head and base are required'));
          return;
        }
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (headTip === undefined || baseTip === undefined) {
          sendJson(res, 422, errJson('head or base branch does not exist'));
          return;
        }
        repo.seq += 1;
        const pull: Pull = {
          number: repo.seq,
          title,
          body: typeof body?.body === 'string' ? body.body : '',
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
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    const num = parseInt(sub[1]!, 10);
    const pull = repo.pulls.find((p) => p.number === num);
    if (sub.length === 2) {
      if (pull === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      sendJson(res, 404, errJson('Not Found'));
      return;
    }
    if (sub[2] === 'files' && sub.length === 3) {
      if (pull === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (method !== 'GET') {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
      const mergeBase = findMergeBase(repo, baseTip, headTip);
      const ancestorFiles = mergeBase === null ? new Map() : branchFilesAt(repo, mergeBase);
      const headFiles = branchFilesAt(repo, headTip);
      sendJson(res, 200, diffFiles(ancestorFiles, headFiles, repo));
      return;
    }
    if (sub[2] === 'merge' && sub.length === 3) {
      if (pull === undefined) {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (method !== 'PUT') {
        sendJson(res, 404, errJson('Not Found'));
        return;
      }
      if (pull.merged || pull.state !== 'open') {
        sendJson(res, 405, errJson('Pull Request is not mergeable'));
        return;
      }
      const mergeMethod = typeof body?.merge_method === 'string' ? body.merge_method : 'squash';
      if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
        sendJson(res, 400, errJson('Invalid merge_method'));
        return;
      }
      const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      if (headTip === undefined || baseTip === undefined) {
        sendJson(res, 422, errJson('head or base branch does not exist'));
        return;
      }
      const mergedFiles = threeWayMerge(repo, baseTip, headTip);
      if (mergedFiles === null) {
        sendJson(res, 405, errJson('Merge conflict'));
        return;
      }
      const message = typeof body?.commit_message === 'string' ? body.commit_message : `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`;
      const mergeCommit = commitFiles(repo, pull.base.ref, mergedFiles, message);
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = nowIso();
      pull.merge_commit_sha = mergeCommit;
      pull.updated_at = nowIso();
      sendJson(res, 200, { sha: mergeCommit, merged: true, message });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  sendJson(res, 404, errJson('Not Found'));
}

function commitMessage(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  if (obj?.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/healthz') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, errJson('Not Found'));
    return;
  }

  if (pathname === '/api/graphql') {
    await handleGraphQL(req, res, store);
    return;
  }

  if (pathname === '/mcp') {
    await handleMcp(req, res, store);
    return;
  }

  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    await handleGit(req, res, store, segments[0]!, segments[1]!.slice(0, -4), segments.slice(2));
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    await handleRest(req, res, store, pathname);
    return;
  }

  sendJson(res, 404, errJson('Not Found'));
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void handleRequest(req, res, store).catch((err: unknown) => {
      process.stderr.write(`[app] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      try {
        sendJson(res, 500, errJson('Internal Server Error'));
      } catch {
        // the response is already gone
      }
    });
  });
  return server;
}
