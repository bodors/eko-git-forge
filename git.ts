// Git smart HTTP: upload-pack (protocol v2 + a v0 fetch fallback) and receive-pack (v0).
// No git binary: objects, trees, commits, tags and packfiles are built and parsed by hand
// in store.ts. Every response is framed with pkt-lines; packs travel in sideband-64k.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  hashObject,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  parsePktLines,
  sidebandFrame,
  collectReachable,
  parseCommit,
  parseTag,
  parseTree,
  isAncestor,
  readPack,
  writePack,
  type Store,
  type Repo,
  type GitObject,
} from './store.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RES_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RES_CT = 'application/x-git-receive-pack-result';

const RECEIVE_CAPS = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function send404(res: ServerResponse): void {
  sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n', 'utf8'));
}

/** All refs of a repo, sorted: heads first, then tags, each alphabetically. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const heads: { name: string; oid: string }[] = [];
  const tags: { name: string; oid: string }[] = [];
  const other: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
    else other.push({ name, oid });
  }
  const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...heads.sort(byName), ...tags.sort(byName), ...other.sort(byName)];
}

/** Peel an annotated tag to its target commit (or the oid itself when it is not a tag). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (obj?.type === 'tag') current = parseTag(obj.data).object;
    else return current;
  }
  return current;
}

/** The commit a tag peels to, when the ref points at an annotated tag; null otherwise. */
function peeledOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj?.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function uploadPackAdvertisement(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0 || headTip === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0${RECEIVE_CAPS}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// v2 ls-refs
// -------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) {
    if (keep('HEAD')) {
      let line = `${headTip} HEAD`;
      if (symrefs) line += ' symref-target:refs/heads/main';
      out.push(pktLine(`${line}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peeledOf(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      out.push(pktLine(`${line}\n`));
    }
  } else if (unborn && keep('HEAD')) {
    let line = 'unborn HEAD';
    if (symrefs) line += ' symref-target:refs/heads/main';
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  return obj?.type === 'commit' ? parseCommit(obj.data).parents : [];
}

function treeClosure(repo: Repo, treeOid: string): Set<string> {
  return collectReachable([treeOid], (oid) => repo.objects.get(oid));
}

/**
 * The objects a fetch must send.
 *  - wants: the tips the client asked for (commits or annotated tags).
 *  - haves: commits the client already holds; everything reachable from them is withheld,
 *    except that traversal stops at the client's shallow boundaries (their parents are not held).
 *  - depth: when set, only commits within `depth` generations of the wants are sent, and the
 *    deepest included commits become the new shallow boundary.
 */
function computeFetch(repo: Repo, wants: readonly string[], haves: readonly string[], shallowBoundaries: readonly string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);
  // Peel wants to commits, remembering tag objects to include.
  const wantCommits: string[] = [];
  const extraObjects = new Map<string, GitObject>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      extraObjects.set(want, obj);
      wantCommits.push(peelToCommit(repo, want));
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    } else {
      extraObjects.set(want, obj);
    }
  }

  // 1. Commits within `depth` generations of the wants (generation 1 = the wants themselves).
  const included = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = wantCommits.map((oid) => ({ oid, gen: 1 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    const known = included.get(oid);
    if (known !== undefined && known <= gen) continue;
    if (repo.objects.get(oid)?.type !== 'commit') continue;
    included.set(oid, gen);
    if (depth === null || gen < depth) {
      for (const parent of commitParents(repo, oid)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // 2. Closure of the included commits: each commit plus its whole tree.
  const toSend = new Map<string, GitObject>();
  for (const [oid] of extraObjects) toSend.set(oid, extraObjects.get(oid)!);
  for (const oid of included.keys()) {
    const commit = repo.objects.get(oid);
    if (commit === undefined) continue;
    toSend.set(oid, commit);
    const tree = parseCommit(commit.data).tree;
    for (const treeOid of treeClosure(repo, tree)) {
      const obj = repo.objects.get(treeOid);
      if (obj !== undefined) toSend.set(treeOid, obj);
    }
  }

  // 3. Held set: closure of the haves, stopping at shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      held.add(have);
      heldQueue.push(peelToCommit(repo, have));
    } else if (obj.type === 'commit') {
      heldQueue.push(have);
    } else {
      held.add(have);
    }
  }
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift()!;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const commit = repo.objects.get(oid);
    if (commit?.type !== 'commit') continue;
    held.add(oid);
    const tree = parseCommit(commit.data).tree;
    for (const treeOid of treeClosure(repo, tree)) held.add(treeOid);
    if (shallowSet.has(oid)) continue; // the client holds this commit but not its parents
    for (const parent of parseCommit(commit.data).parents) heldQueue.push(parent);
  }

  for (const oid of held) toSend.delete(oid);

  // 4. Shallow-info: deepest included commits are the new boundary; old boundaries we passed
  //    are unshallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of included) if (gen === depth) shallow.push(oid);
    for (const boundary of shallowBoundaries) {
      const gen = included.get(boundary);
      if (gen !== undefined && gen < depth) unshallow.push(boundary);
    }
  }
  return { objects: toSend, shallow, unshallow };
}

function fetchResponseV2(repo: Repo, args: string[], haves: string[]): Buffer {
  const wants: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = computeFetch(repo, wants, haves, shallowBoundaries, depth);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack([...plan.objects.values()].sort((a, b) => (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1)));
  parts.push(sidebandFrame(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, wants: string[], haves: string[], shallowBoundaries: string[], depth: number | null): Buffer {
  const plan = computeFetch(repo, wants, haves, shallowBoundaries, depth);
  const parts: Buffer[] = [];
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack([...plan.objects.values()]);
  parts.push(sidebandFrame(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

function parseV2Request(lines: string[]): { command: string; args: string[] } | null {
  if (lines.length === 0) return null;
  const first = lines[0]!;
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length).trim();
  const args: string[] = [];
  let afterDelim = false;
  for (const line of lines.slice(1)) {
    if (line === '') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim && (line.startsWith('agent=') || line.startsWith('object-format='))) continue;
    args.push(line);
  }
  return { command, args };
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = parsePktLines(body);
  void rest;
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload!.toString('utf8').replace(/\n$/, ''));
  const v2 = parseV2Request(lines);
  if (v2 !== null) {
    if (v2.command === 'ls-refs') {
      sendBuffer(res, 200, UPLOAD_RES_CT, handleLsRefs(repo, v2.args));
      return;
    }
    if (v2.command === 'fetch') {
      const haves: string[] = [];
      for (const line of v2.args) if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      sendBuffer(res, 200, UPLOAD_RES_CT, fetchResponseV2(repo, v2.args, haves));
      return;
    }
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from(`unknown command ${v2.command}\n`, 'utf8'));
    return;
  }
  // v0 fetch: want lines (first may carry capabilities), shallow/deepen, flush, have lines, done.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let inNegotiation = false;
  for (const line of lines) {
    if (line === '') {
      inNegotiation = true;
      continue;
    }
    if (line.startsWith('want ')) {
      const restLine = line.slice(5);
      wants.push(restLine.split(' ')[0]!);
    } else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') inNegotiation = true;
  }
  void inNegotiation;
  if (wants.length === 0) {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('no want lines in upload-pack request\n', 'utf8'));
    return;
  }
  sendBuffer(res, 200, UPLOAD_RES_CT, fetchResponseV0(repo, wants, haves, shallowBoundaries, depth));
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; packStart: number } | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return null;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) return null;
    const text = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    const parts = commandText.split(' ');
    if (parts.length !== 3) return null;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    offset += len;
  }
  return { commands, packStart: offset };
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const parsed = parsePushCommands(body);
  if (parsed === null || parsed.commands.length === 0) {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed receive-pack command list\n', 'utf8'));
    return;
  }
  const { commands, packStart } = parsed;
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    const packBytes = body.subarray(packStart);
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = readPack(packBytes);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
        process.stderr.write(`[git] receive-pack unpack failed: ${(err as Error).message}\n`);
      }
    }
  }
  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (repo.objects.get(command.newOid) === undefined) {
      reportLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (current === undefined) {
      // create
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    // update
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!isAncestor(repo.objects, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  const report = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
  sendBuffer(res, 200, RECEIVE_RES_CT, Buffer.concat([sidebandFrame(1, report), PKT_FLUSH]));
}

// -------------------------------------------------------------------------------------------
// dispatcher
// -------------------------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  sub: string[],
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (sub.length === 2 && sub[0] === 'info' && sub[1] === 'refs') {
    const service = new URL(req.url ?? '/', 'http://localhost').searchParams.get('service');
    if (repo === undefined) {
      send404(res);
      return;
    }
    if (service === 'git-upload-pack') {
      sendBuffer(res, 200, UPLOAD_AD_CT, uploadPackAdvertisement(repo));
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, RECEIVE_AD_CT, receivePackAdvertisement(repo));
      return;
    }
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n', 'utf8'));
    return;
  }
  if (repo === undefined) {
    send404(res);
    return;
  }
  if (sub.length === 1 && sub[0] === 'git-upload-pack' && req.method === 'POST') {
    try {
      await handleUploadPack(req, res, repo);
    } catch (err) {
      process.stderr.write(`[git] upload-pack failed: ${(err as Error).message}\n`);
      try {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed upload-pack request\n', 'utf8'));
      } catch {
        // response already gone
      }
    }
    return;
  }
  if (sub.length === 1 && sub[0] === 'git-receive-pack' && req.method === 'POST') {
    try {
      await handleReceivePack(req, res, repo);
    } catch (err) {
      process.stderr.write(`[git] receive-pack failed: ${(err as Error).message}\n`);
      try {
        sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed receive-pack request\n', 'utf8'));
      } catch {
        // response already gone
      }
    }
    return;
  }
  sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n', 'utf8'));
}
