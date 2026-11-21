// MCP: JSON-RPC 2.0 Streamable HTTP on the same in-memory store as REST.
// Modern era (2026-07-28) via server/discover; legacy initialize handshake kept for
// pre-discover clients. Tool results are JSON in a text content block.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  nowIso,
  threeWayMerge,
  commitFiles,
  type Repo,
} from './store.ts';
import { repoJson, issueJson, pullJson } from './app.ts';

const SERVER_NAME = 'eko-git-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

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

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(def: ToolDef, args: Record<string, unknown>): string[] {
  return def.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function getRepoArg(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = args.owner as string | undefined;
  const repo = args.repo as string | undefined;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (def === undefined) {
    // Unknown tool: the caller turns this into a JSON-RPC error, it never becomes a tool result.
    throw new Error(`__unknown_tool__:${name}`);
  }
  const missing = missingArgs(def, args);
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (store.getRepo(VIEWER.login, repoName) !== undefined) {
        return toolError('Repository already exists');
      }
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = getRepoArg(store, args);
      if (repo === null) return toolError('Not Found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = getRepoArg(store, args);
      if (repo === null) return toolError('Not Found');
      const title = args.title as string;
      repo.seq += 1;
      const issue = {
        id: repo.seq,
        number: repo.seq,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [],
        user: { login: VIEWER.login },
        created_at: nowIso(),
        updated_at: nowIso(),
        comments: [],
      };
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepoArg(store, args);
      if (repo === null) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return toolResult(items.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = getRepoArg(store, args);
      if (repo === null) return toolError('Not Found');
      const head = args.head as string;
      const base = args.base as string;
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) return toolError('head or base branch does not exist');
      repo.seq += 1;
      const pull = {
        number: repo.seq,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
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
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepoArg(store, args);
      if (repo === null) return toolError('Not Found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return toolError('Not Found');
      if (pull.merged || pull.state !== 'open') return toolError('Pull Request is not mergeable');
      const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      if (headTip === undefined || baseTip === undefined) return toolError('head or base branch does not exist');
      const mergedFiles = threeWayMerge(repo, baseTip, headTip);
      if (mergedFiles === null) return toolError('Merge conflict');
      const mergeCommit = commitFiles(repo, pull.base.ref, mergedFiles, `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`);
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = nowIso();
      pull.merge_commit_sha = mergeCommit;
      pull.updated_at = nowIso();
      return toolResult(pullJson(repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: POST only' } });
    return;
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (token === '' ? !(header.startsWith('Bearer ') && header.slice(7).length > 0) : header !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const id = body.id === undefined ? null : body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no JSON-RPC answer (HTTP 202, empty body).
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  const ok = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): void =>
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover':
      ok({
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'initialize': {
      const offered = params.protocolVersion;
      const revision = typeof offered === 'string' && offered.startsWith('2025-') ? offered : LEGACY_REVISION;
      ok({
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'ping':
      ok({});
      return;
    case 'tools/list':
      ok({ tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (toolName === '') {
        fail(-32602, 'Invalid params: tools/call needs a tool name');
        return;
      }
      try {
        ok(callTool(store, toolName, args));
      } catch (err) {
        const message = (err as Error).message;
        if (message.startsWith('__unknown_tool__:')) {
          fail(-32601, `Unknown tool: ${toolName}`);
        } else {
          fail(-32603, `Internal error: ${message}`);
        }
      }
      return;
    }
    default:
      fail(-32601, `Method not found: ${method}`);
  }
}
