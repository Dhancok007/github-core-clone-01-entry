// Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack and
// git-receive-pack. Protocol v2 (ls-refs, fetch) for the suite's client and
// protocol v0 for real git clients; receive-pack is v0 with report-status.
//
// Fetch sends only the objects the client lacks: the closure of the wants
// minus the closure of the haves, where shallow haves cut the walk at the
// shallow boundary the client declares. Packs are whole objects (no deltas).

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parsePktLines,
  parseTag,
  pktLine,
  readPack,
  writePack,
} from './gitstore.ts';
import { nextRequestId } from './http.ts';

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';
const FETCH_CAPS_V2 = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

/** The v2 advertisement never changes: build it once. */
const V2_ADVERTISEMENT = Buffer.concat(
  ['version 2', ...FETCH_CAPS_V2].map((line) => pktLine(`${line}\n`)).concat([PKT_FLUSH]),
);

/**
 * Response caching. Objects are immutable and content-addressed, so a fetch
 * response is a pure function of its request bytes once every want and have
 * it names exists in the store: it can be replayed verbatim forever.
 * Responses that depend on the (mutable) refs — advertisements and ls-refs —
 * are keyed by an exact fingerprint of the refs map, so any ref change is a
 * different key. The cache lives on the repo record and is cleared when it
 * grows past a small bound.
 */
const RESP_CACHE_MAX = 256;

function cacheGet(repo, key) {
  return repo.respCache.get(key);
}

function cachePut(repo, key, body) {
  if (repo.respCache.size >= RESP_CACHE_MAX) repo.respCache.clear();
  repo.respCache.set(key, body);
}

/** Exact, cheap fingerprint of a repo's refs (and HEAD target). */
function refsFingerprint(repo) {
  let fp = repo.defaultBranch;
  for (const [ref, oid] of repo.refs) fp += `|${ref}=${oid}`;
  return fp;
}

/** The command a v2 upload-pack request opens with ('' for a v0 request). */
function uploadCommandOf(rawBody) {
  if (rawBody.length < 4) return '';
  const length = parseInt(rawBody.subarray(0, 4).toString('ascii'), 16);
  if (!Number.isFinite(length) || length <= 4 || rawBody.length < length) return '';
  const first = rawBody.subarray(4, length).toString('utf8');
  if (first.startsWith('command=ls-refs')) return 'ls-refs';
  if (first.startsWith('command=fetch')) return 'fetch';
  return '';
}

function sendBuffer(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendGitError(res, status) {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
}

/** All refs of a repo as [refname, oid] pairs, sorted by refname. */
function sortedRefs(repo) {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headTarget(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Route the three git endpoints. Returns true when the path was claimed. */
export function handleGitHttp(forge, req, res, url, rawBody) {
  const match = /^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/.exec(url.pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const tail = match[3] ?? '';
  const isInfoRefs = tail === '/info/refs';
  const isUpload = tail === '/git-upload-pack';
  const isReceive = tail === '/git-receive-pack';
  if (!isInfoRefs && !isUpload && !isReceive) return false;

  forge.learnViewer(owner);
  const repo = forge.ownerAllowed(owner) ? forge.repo(repoName) : null;
  if (repo === null) {
    sendGitError(res, 404);
    return true;
  }

  if (isInfoRefs) {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') return advertiseUpload(forge, req, res, repo), true;
    if (service === 'git-receive-pack') return advertiseReceive(res, repo), true;
    sendGitError(res, 400);
    return true;
  }
  if (isUpload) {
    if (req.method !== 'POST') { sendGitError(res, 405); return true; }
    return uploadPack(forge, req, res, repo, rawBody), true;
  }
  if (req.method !== 'POST') { sendGitError(res, 405); return true; }
  return receivePack(forge, req, res, repo, rawBody), true;
}

function wantsV2(req) {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && /(^|,)version=2/.test(header.replace(/\s/g, ''));
}

// ---------------------------------------------------------------------------
// advertisements

function advertiseUpload(forge, req, res, repo) {
  if (wantsV2(req)) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
    return;
  }
  const cacheKey = `adv:up:${refsFingerprint(repo)}`;
  const cached = cacheGet(repo, cacheKey);
  if (cached !== undefined) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', cached);
    return;
  }
  const parts = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  const symref = `symref=HEAD:${headTarget(repo)}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS_V0} ${symref}\n`));
  } else {
    let first = true;
    parts.push(pktLine(`${headOid} HEAD\0${UPLOAD_CAPS_V0} ${symref}\n`));
    first = false;
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const object = forge.get(oid);
      if (object && object.type === 'tag') {
        const target = parseTag(object.data).object;
        parts.push(pktLine(`${target} ${ref}^{}\n`));
      }
      void first;
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  cachePut(repo, cacheKey, body);
  sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body);
}

function advertiseReceive(res, repo) {
  const cacheKey = `adv:rec:${refsFingerprint(repo)}`;
  const cached = cacheGet(repo, cacheKey);
  if (cached !== undefined) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', cached);
    return;
  }
  const parts = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${RECEIVE_CAPS}\n`));
    for (const [ref, oid] of refs) parts.push(pktLine(`${oid} ${ref}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  cachePut(repo, cacheKey, body);
  sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', body);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

function lsRefs(forge, repo, packets) {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { inArgs = true; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matchesPrefix = (ref) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const out = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (matchesPrefix('HEAD')) {
    if (headOid) {
      out.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}`);
    } else if (unborn) {
      out.push(`unborn HEAD symref-target:${headTarget(repo)}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matchesPrefix(ref)) continue;
    let line = `${oid} ${ref}`;
    const object = forge.get(oid);
    if (peel && object && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    out.push(line);
  }
  const parts = out.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch

function parseFetchArgs(packets) {
  const args = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, done: false };
  let section = 0; // 0 = capabilities (v2) or wants (v0), 1 = arguments, 2 = haves (v0)
  for (const packet of packets) {
    if (packet.kind === 'delim') { section = 1; continue; }
    if (packet.kind === 'flush') { section = 2; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0 || section === 1) {
      // v0 want lines may carry capabilities after the oid; take the first token.
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(/\s+/)[0]);
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
      else if (line === 'deepen-relative') args.deepenRelative = true;
      else if (line === 'done') args.done = true;
    } else if (section === 2) {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line === 'done') args.done = true;
    }
  }
  return args;
}

/** Depth-limited closure: the `depth` nearest commit levels from the tips.
 *  The deepest included commits that still have (excluded) parents are the
 *  shallow boundary — they travel in the pack and are named by shallow lines. */
function depthLimitedSet(forge, tips, depth) {
  const include = new Set();
  const boundary = new Set();
  let frontier = [...tips];
  for (let level = 1; level <= depth; level += 1) {
    const next = [];
    for (const oid of frontier) {
      const object = forge.get(oid);
      if (!object) continue;
      include.add(oid);
      if (object.type === 'tag') { next.push(parseTag(object.data).object); continue; }
      if (object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      include.add(commit.tree);
      if (level === depth) {
        if (commit.parents.length) boundary.add(oid);
      } else {
        next.push(...commit.parents);
      }
    }
    frontier = next;
  }
  // trees and blobs of every included commit
  const full = new Set(include);
  for (const oid of include) {
    const object = forge.get(oid);
    if (object && object.type === 'commit') {
      for (const sub of collectReachable(forge.objects, [parseCommit(object.data).tree])) full.add(sub);
    }
  }
  return { objects: full, boundary };
}

/** Deepen-relative: extend `levels` commit levels below the client's current
 *  shallow boundary. Commits above the boundary are walked freely (the client
 *  holds them; the have-closure subtraction removes them from the pack). The
 *  boundary is computed afterwards: included commits with an excluded parent. */
function relativeDeepenSet(forge, tips, shallowSet, levels) {
  const include = new Set();
  const best = new Map(); // oid -> sort key: -1 above the boundary, else levels below it
  const queue = tips.map((oid) => [oid, -1]);
  while (queue.length) {
    const [oid, key] = queue.shift();
    if (key > levels) continue;
    if (best.has(oid) && best.get(oid) <= key) continue;
    best.set(oid, key);
    const object = forge.get(oid);
    if (!object) continue;
    include.add(oid);
    if (object.type === 'tag') { queue.push([parseTag(object.data).object, key]); continue; }
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    include.add(commit.tree);
    for (const parent of commit.parents) {
      // Leaving a shallow commit crosses below the boundary; every further
      // edge below the boundary counts one more level.
      const parentKey = key >= 0 ? key + 1 : shallowSet.has(oid) ? 1 : -1;
      queue.push([parent, parentKey]);
    }
  }
  const boundary = new Set();
  for (const oid of include) {
    const object = forge.get(oid);
    if (object && object.type === 'commit') {
      if (parseCommit(object.data).parents.some((parent) => !include.has(parent))) boundary.add(oid);
    }
  }
  const full = new Set(include);
  for (const oid of include) {
    const object = forge.get(oid);
    if (object && object.type === 'commit') {
      for (const sub of collectReachable(forge.objects, [parseCommit(object.data).tree])) full.add(sub);
    }
  }
  return { objects: full, boundary };
}

function computeFetch(forge, args) {
  const wantSet = new Set(args.wants.filter((oid) => forge.get(oid)));
  const haveKnown = args.haves.filter((oid) => forge.get(oid));
  const shallowBoundary = new Set(args.shallow);
  const haveClosure = collectReachable(forge.objects, haveKnown, shallowBoundary);
  const ready = args.wants.length > 0 && args.wants.every((oid) => haveClosure.has(oid));

  let sendSet;
  let shallowInfo = [];
  if (args.deepen !== null && args.deepen > 0) {
    const { objects, boundary } = args.deepenRelative
      ? relativeDeepenSet(forge, [...wantSet], shallowBoundary, args.deepen)
      : depthLimitedSet(forge, [...wantSet], args.deepen);
    sendSet = new Set([...objects].filter((oid) => !haveClosure.has(oid)));
    const clientShallow = new Set(args.shallow);
    for (const oid of boundary) if (!clientShallow.has(oid)) shallowInfo.push(`shallow ${oid}`);
    for (const oid of clientShallow) {
      if (objects.has(oid) && !boundary.has(oid)) shallowInfo.push(`unshallow ${oid}`);
    }
  } else {
    const wantClosure = collectReachable(forge.objects, [...wantSet], shallowBoundary);
    sendSet = new Set([...wantClosure].filter((oid) => !haveClosure.has(oid)));
  }
  const acks = haveKnown.length ? haveKnown.map((oid) => `ACK ${oid}`) : ['NAK'];
  return { sendSet, acks, ready, shallowInfo };
}

function sidebandPack(pack) {
  const parts = [];
  const CHUNK = 65520 - 5;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1])])));
  return parts;
}

function fetchV2(forge, repo, packets) {
  const args = parseFetchArgs(packets);
  const { sendSet, acks, ready, shallowInfo } = computeFetch(forge, args);
  const parts = [];
  if (!args.done && !ready) {
    // Negotiation round: acknowledgments only; the client will send more.
    parts.push(pktLine('acknowledgments\n'));
    for (const ack of acks) parts.push(pktLine(`${ack}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // Sections of one v2 response are separated by a delim packet; a flush
  // ends the whole response. (git reads a flush as end-of-response, so a
  // flush between sections truncates the exchange.)
  if (!args.done) {
    // 'ready' completes negotiation: the remaining sections follow in the
    // same response.
    parts.push(pktLine('acknowledgments\n'));
    for (const ack of acks) if (ack !== 'NAK') parts.push(pktLine(`${ack}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (shallowInfo.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowInfo) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  const objects = [...sendSet].map((oid) => forge.get(oid)).filter(Boolean);
  const pack = writePack(objects.map((object) => ({ type: object.type, data: object.data })));
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(forge, repo, packets) {
  const args = parseFetchArgs(packets);
  const { sendSet, shallowInfo } = computeFetch(forge, args);
  const parts = [];
  for (const line of shallowInfo) parts.push(pktLine(`${line}\n`));
  const haveKnown = args.haves.filter((oid) => forge.get(oid));
  if (haveKnown.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of haveKnown) parts.push(pktLine(`ACK ${oid} common\n`));
    parts.push(pktLine(`ACK ${haveKnown[haveKnown.length - 1]} ready\n`));
  }
  const objects = [...sendSet].map((oid) => forge.get(oid)).filter(Boolean);
  const pack = writePack(objects.map((object) => ({ type: object.type, data: object.data })));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function uploadPack(forge, req, res, repo, rawBody) {
  const command = uploadCommandOf(rawBody);
  const bodyKey = rawBody.toString('latin1');
  if (command === 'ls-refs') {
    const key = `lsr:${refsFingerprint(repo)}:${bodyKey}`;
    const cached = cacheGet(repo, key);
    if (cached !== undefined) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached);
      return;
    }
    const { packets } = parsePktLines(rawBody);
    const body = lsRefs(forge, repo, packets);
    cachePut(repo, key, body);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
    return;
  }
  if (command === 'fetch' || !wantsV2(req)) {
    const key = `fetch:${bodyKey}`;
    const cached = cacheGet(repo, key);
    if (cached !== undefined) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached);
      return;
    }
    const { packets } = parsePktLines(rawBody);
    const body = command === 'fetch' ? fetchV2(forge, repo, packets) : fetchV0(forge, repo, packets);
    // Replay is sound only when the response is a pure function of immutable
    // objects: every want and have the request names must already exist.
    const args = parseFetchArgs(packets);
    const allKnown = args.wants.length > 0
      && args.wants.every((oid) => forge.get(oid))
      && args.haves.every((oid) => forge.get(oid))
      && args.shallow.every((oid) => forge.get(oid));
    if (allKnown) cachePut(repo, key, body);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
    return;
  }
  sendGitError(res, 400);
}

// ---------------------------------------------------------------------------
// receive-pack

function receivePack(forge, req, res, repo, rawBody) {
  const { packets, rest } = parsePktLines(rawBody, true);
  const commands = [];
  let capabilities = '';
  packets.forEach((packet, index) => {
    if (packet.kind !== 'data') return;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });
  const useSideband = /(^|\s)side-band-64k(\s|$)/.test(capabilities);
  const wantsReport = /(^|\s)report-status(\s|$)/.test(capabilities);

  let unpackOk = true;
  let newObjects = new Map();
  if (rest.length > 0) {
    try {
      // readPack verifies the pack trailer checksum and keys its result by
      // each object's content hash, so the ids need no second verification.
      newObjects = readPack(rest, (oid) => forge.get(oid));
    } catch {
      unpackOk = false;
    }
  }

  const report = [];
  if (!unpackOk) {
    report.push('unpack error: the pack could not be read');
    for (const command of commands) report.push(`ng ${command.ref} unpack failed`);
  } else {
    for (const [oid, object] of newObjects) {
      if (!forge.objects.has(oid)) forge.objects.set(oid, object);
    }
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (current !== command.oldOid) {
        report.push(`ng ${command.ref} stale info`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (command.ref === headRefOf(repo)) {
          report.push(`ng ${command.ref} deletion of the current branch prohibited`);
          continue;
        }
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}`);
        continue;
      }
      const target = forge.get(command.newOid);
      if (!target) {
        report.push(`ng ${command.ref} missing object`);
        continue;
      }
      if (command.oldOid !== ZERO_OID && target.type === 'commit') {
        const oldCommit = forge.get(command.oldOid);
        if (oldCommit && oldCommit.type === 'commit' && !isAncestor(forge.objects, command.oldOid, command.newOid)) {
          report.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
    }
  }

  if (!wantsReport) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines = [unpackOk ? 'unpack ok' : report[0], ...report.slice(unpackOk ? 0 : 1).filter((line) => line.startsWith('ok ') || line.startsWith('ng '))];
  const inner = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)).concat([PKT_FLUSH]));
  let body;
  if (useSideband) {
    const parts = [];
    const CHUNK = 65520 - 5;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(inner.length, offset + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    body = Buffer.concat(parts);
  } else {
    body = inner;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', body);
}

function headRefOf(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}
