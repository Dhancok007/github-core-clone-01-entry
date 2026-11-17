// Git object model, packfile read/write and pkt-line framing, in pure Node
// standard library (node:crypto for SHA-1, node:zlib for deflate streams).
// Objects are stored content-addressed: oid -> { type, data } where data is the
// raw object body (no "<type> <size>\0" header; the header is only for hashing).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

export function sha1Hex(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// pkt-line

export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse a complete pkt-line stream; returns { packets, rest } where rest is
 *  any raw trailing bytes after the terminating flush (a push pack). Each
 *  packet is { kind: 'data'|'flush'|'delim', payload }. Parsing stops at the
 *  first flush when stopAtFlush is set. */
export function parsePktLines(buffer, stopAtFlush = false) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) return { packets, rest: buffer.subarray(offset) };
      continue;
    }
    if (length === 1) { packets.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// object parsing / building

export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeNameKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeNameKey(a), 'utf8');
    const kb = Buffer.from(treeNameKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit({ tree, parents = [], author, committer, timestamp, message }) {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`);
  lines.push(`committer ${committer ?? author} ${timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const out = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    if (key in out) out[key] = line.slice(space + 1);
  }
  return out;
}

/** Peel an object id to the commit it ultimately names (tag chains), or null. */
export function peelToCommit(store, oid) {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') { current = parseTag(object.data).object; continue; }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// packfiles

function writePackHeaderEntry(out, typeCode, size) {
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  const bytes = [];
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  out.push(Buffer.from(bytes));
}

/**
 * Packets of a pack entry (type/size header + deflated body) are a pure
 * function of the object's content, and objects are immutable, so they are
 * cached by object id: a fetch that packs the same objects twice pays the
 * deflate cost once. The cache is bounded and simply cleared when full.
 */
const packEntryCache = new Map();
const PACK_ENTRY_CACHE_MAX = 8192;

function packEntryBytes(oid, type, data) {
  let entry = packEntryCache.get(oid);
  if (entry === undefined) {
    const entryHeader = [];
    writePackHeaderEntry(entryHeader, TYPE_CODE[type], data.length);
    entry = Buffer.concat([...entryHeader, deflateSync(data)]);
    if (packEntryCache.size >= PACK_ENTRY_CACHE_MAX) packEntryCache.clear();
    packEntryCache.set(oid, entry);
  }
  return entry;
}

/** A version-2 pack of whole objects (no deltas), with a valid trailer. */
export function writePack(objects) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryBytes(hashObject(object.type, object.data), object.type, object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer, offset) {
  const result = inflateSync(buffer.subarray(offset), { info: true });
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base, delta) {
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
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
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a pack and resolve every entry to a whole object. `lookup(oid)` supplies
 * bases the pack leaves out (thin packs). Returns a Map oid -> {type, data}.
 * Throws on a corrupt pack.
 */
export function readPack(pack, lookup) {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack checksum mismatch');
  const entries = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid = null;
    let baseOffset = null;
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    entries.push({ offset: entryOffset, typeCode, data: inflated.data, baseOid, baseOffset });
  }
  const byOffset = new Map();
  const resolved = new Map();
  const resolveEntry = (entry) => {
    const existing = resolved.get(entry.offset);
    if (existing) return existing;
    let object;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base missing from pack');
        base = resolveEntry(baseEntry);
      } else {
        base = resolved.get(entry.baseOid) ?? null;
        if (!base) {
          const inPack = entries.find((candidate) => candidate.typeCode !== 6 && candidate.typeCode !== 7 && hashObject(CODE_TYPE[candidate.typeCode], candidate.data) === entry.baseOid);
          if (inPack) base = resolveEntry(inPack);
        }
        if (!base && lookup) {
          const found = lookup(entry.baseOid);
          if (found) base = found;
        }
        if (!base) throw new Error('ref-delta base missing');
      }
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      object = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    resolved.set(entry.offset, object);
    resolved.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const out = new Map();
  for (const entry of entries) {
    const object = resolveEntry(entry);
    out.set(hashObject(object.type, object.data), object);
  }
  return out;
}

// ---------------------------------------------------------------------------
// reachability

/** Every object reachable from the given tips. `boundary` commits are included
 *  but their parents are not walked (a shallow client's existing holdings). */
export function collectReachable(store, tips, boundary = new Set()) {
  const seen = new Set();
  const queue = [...tips];
  while (queue.length) {
    const oid = queue.pop();
    if (!oid || seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!boundary.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Ancestor test: is `ancestor` reachable from `descendant` through parents? */
export function isAncestor(store, ancestor, descendant) {
  const seen = new Set();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop();
    if (oid === ancestor) return true;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits (BFS from both), or null. */
export function mergeBase(store, a, b) {
  const ancestorsOf = (tip) => {
    const set = new Set();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop();
      if (!oid || set.has(oid)) continue;
      set.add(oid);
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return set;
  };
  const fromA = ancestorsOf(a);
  const queue = [b];
  const seen = new Set();
  while (queue.length) {
    const oid = queue.shift();
    if (fromA.has(oid)) return oid;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}
