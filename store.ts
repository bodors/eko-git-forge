// Shared store + git object model for the forge.
// Pure Node stdlib (node:crypto, node:zlib). No git binary anywhere: objects, trees,
// commits, tags and packfiles are built and parsed here by hand.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The login the bearer token names (the scenario's viewer; fixed by the sealed env). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const VIEWER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Encode tree entries in git's canonical order: names compared bytewise, directories as `name/`. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  // The blank line between the header and the message is part of the format:
  // lines.join('\n') ends with '\n' (from the empty element) and one more '\n'
  // makes the separator, exactly as git writes it. The message is stored verbatim.
  const text = `${lines.join('\n')}\n${fields.message}`;
  return Buffer.from(text, 'utf8');
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) timestamp = parseInt(m[1], 10);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, timestamp, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  // The message is stored verbatim, as git writes it.
  const text = `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`;
  return Buffer.from(text, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------------------
// packfiles (full objects only; the client never sends deltas)
// -------------------------------------------------------------------------------------------

const PACK_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_ID: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(2, 0);
  parts[2]!.writeUInt32BE(list.length, 0);
  for (const obj of list) {
    const typeId = PACK_TYPE_ID[obj.type];
    const size = obj.data.length;
    const header: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    header.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length) throw new Error('truncated packfile');
    let byte = buf[offset]!;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = buf[offset]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    const type = PACK_TYPE[typeId];
    if (type === undefined) throw new Error(`pack entry type ${typeId} (delta packs are not accepted)`);
    // inflateSync with info:true reports how many input bytes the zlib stream consumed,
    // which is exactly where the next pack entry starts.
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
    } catch (err) {
      throw new Error(`pack entry zlib stream did not inflate: ${(err as Error).message}`);
    }
    const data = inflated.buffer;
    if (data.length !== size) throw new Error(`pack entry decompressed to ${data.length} bytes, header says ${size}`);
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('pack entry zlib stream consumed no bytes');
    offset += consumed;
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  payload?: Buffer;
}

/** Parse pkt-lines from a buffer; returns packets and any trailing bytes (e.g. a pack). */
export function parsePktLines(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Side-band-64k frame a payload: band byte + data, chunked into pkt-lines. */
export function sidebandFrame(band: number, data: Buffer): Buffer {
  const frames: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < data.length || frames.length === 0; off += MAX) {
    const chunk = data.subarray(off, off + MAX);
    frames.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
    if (chunk.length === 0) break;
  }
  return Buffer.concat(frames);
}

// -------------------------------------------------------------------------------------------
// object graph helpers
// -------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(objects, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build nested trees for a full file map; returns the root tree oid and stores every new object. */
export function buildTreeForFiles(
  objects: Map<string, GitObject>,
  files: Map<string, { oid: string; mode: string }>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, make());
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** True when `ancestor` is reachable from `tip` (or equal); used for fast-forward checks. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** List commit oids reachable from a tip, newest-first (parents after children, BFS by depth). */
export function listCommits(objects: Map<string, GitObject>, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj?.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// the store
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  seq: number;
  commentSeq: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The trial's fixed now: MAKEFUN_TRIAL_NOW (an RFC 3339 instant or epoch milliseconds),
 * falling back to the wall clock when the trial does not set one. Every timestamp the forge
 * emits comes from here, so a live pass and its replay answer identically.
 */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function nowIso(): string {
  return new Date(trialNowMs()).toISOString();
}

export function nowSec(): number {
  return Math.floor(trialNowMs() / 1000);
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo {
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      seq: 0,
      commentSeq: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

/** Commit a new file map onto a branch; creates blob/tree/commit objects, moves the ref. */
export function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = buildTreeForFiles(repo.objects, files);
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName);
  const commitData = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    message,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: nowSec(),
  });
  const commitOid = hashObject('commit', commitData);
  if (!repo.objects.has(commitOid)) repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(refName, commitOid);
  return commitOid;
}

/** The file map of a branch tip (empty when the branch does not exist). */
export function branchFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return new Map();
  const commit = repo.objects.get(tip);
  if (commit?.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(commit.data).tree);
}

/** Store a blob's bytes; returns its oid. */
export function putBlob(repo: Repo, data: Buffer): string {
  const oid = hashObject('blob', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'blob', data });
  return oid;
}

/** The file map of a commit oid (empty when the commit does not exist). */
export function branchFilesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const commit = repo.objects.get(commitOid);
  if (commit?.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(commit.data).tree);
}

export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') queueA.push(...parseCommit(obj.data).parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') queueB.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Three-way file-level merge of base+head over their merge-base; null when conflicted. */
export function threeWayMerge(
  repo: Repo,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const baseFiles = branchFilesAt(repo, baseTip);
  const headFiles = branchFilesAt(repo, headTip);
  const mergeBase = findMergeBase(repo, baseTip, headTip);
  const ancestorFiles = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : branchFilesAt(repo, mergeBase);
  const out = new Map(baseFiles);
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, a)) continue; // head did not change it: keep base
    if (same(b, a)) {
      // base did not change it: take head
      if (h === undefined) out.delete(path);
      else out.set(path, h);
      continue;
    }
    if (same(b, h)) continue; // both changed to the same thing
    return null; // both changed it differently: conflict
  }
  return out;
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  return obj?.type === 'blob' ? obj.data.toString('utf8') : '';
}

function blobLines(repo: Repo, oid: string): number {
  const text = blobText(repo, oid);
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Diff two file maps: added/removed/modified with line counts. */
export function diffFiles(
  oldFiles: Map<string, { oid: string; mode: string }>,
  newFiles: Map<string, { oid: string; mode: string }>,
  repo: Repo,
): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const lines = blobLines(repo, newEntry.oid);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const lines = blobLines(repo, oldEntry.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldLines = blobText(repo, oldEntry.oid).split('\n');
      const newLines = blobText(repo, newEntry.oid).split('\n');
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      let additions = 0;
      let deletions = 0;
      for (const line of newLines) if (!oldSet.has(line)) additions += 1;
      for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}
