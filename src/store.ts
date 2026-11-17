// The forge's state: one object store shared by every repository (objects are
// content-addressed, so sharing is safe), per-repo refs, and the REST-level
// records (issues, pull requests, comments, labels) that live beside the git
// data. Everything is in memory; a trial starts from an empty forge.
//
// Determinism: API-created commits and timestamps come from a monotone counter
// seeded at a fixed epoch, never from the wall clock, so the same request
// sequence always produces the same object ids.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
} from './gitstore.ts';

const EPOCH = 1700000000;

export class Forge {
  constructor() {
    this.objects = new Map(); // oid -> {type, data}
    this.repos = new Map(); // name -> repo record
    this.repoSeq = 0;
    this.issueSeq = 0; // global REST issue/comment id counter
    this.clock = 0; // deterministic timestamp counter
    this.viewerLogin = null; // learned from the first owner-addressed request
    this.flatCache = new Map(); // commit oid -> Map(path -> {oid, mode})
  }

  tick() {
    this.clock += 1;
    return EPOCH + this.clock;
  }

  isoNow() {
    return new Date(this.tick() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // ------------------------------------------------------------ viewer login

  /** Record the token owner's login the first time a request addresses a
   *  repository under an owner segment; later, foreign owners are refused. */
  learnViewer(owner) {
    if (owner && this.viewerLogin === null) this.viewerLogin = owner;
  }

  ownerAllowed(owner) {
    return this.viewerLogin === null || owner === this.viewerLogin;
  }

  viewer() {
    return this.viewerLogin ?? 'viewer';
  }

  // ------------------------------------------------------------ objects

  put(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid) {
    return this.objects.get(oid);
  }

  lookup(oid) {
    return this.objects.get(oid);
  }

  // ------------------------------------------------------------ repos

  createRepo(name, { description = '', isPrivate = true } = {}) {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo = {
      id: this.repoSeq,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(), // refname -> oid
      issues: new Map(), // number -> issue
      pulls: new Map(), // number -> pull
      labels: new Map(), // name -> {name, color}
      nextNumber: 1, // issues and pulls share one sequence, as on GitHub
      createdAt: this.isoNow(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  repo(name) {
    return this.repos.get(name) ?? null;
  }

  deleteRepo(name) {
    return this.repos.delete(name);
  }

  repoList() {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------ trees

  /** Flatten a commit's tree into path -> {oid, mode}; cached per commit. */
  flatten(commitOid) {
    if (this.flatCache.has(commitOid)) return this.flatCache.get(commitOid);
    const flat = new Map();
    const commit = this.objects.get(commitOid);
    if (commit && commit.type === 'commit') {
      const walk = (treeOid, prefix) => {
        const tree = this.objects.get(treeOid);
        if (!tree || tree.type !== 'tree') return;
        for (const entry of parseTree(tree.data)) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.mode === '40000') walk(entry.oid, path);
          else flat.set(path, { oid: entry.oid, mode: entry.mode });
        }
      };
      walk(parseCommit(commit.data).tree, '');
    }
    this.flatCache.set(commitOid, flat);
    return flat;
  }

  /** Rebuild nested tree objects from a flattened path map; returns root oid. */
  buildFromFlat(flat) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
        node = node.dirs.get(segments[i]);
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node) => {
      const entries = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  branchTip(repo, branch) {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a REST `ref` value (branch, tag or sha) to a commit oid. */
  resolveRef(repo, ref) {
    if (!ref) {
      const tip = this.branchTip(repo, repo.defaultBranch);
      return tip;
    }
    const branchTip = this.branchTip(repo, ref);
    if (branchTip) return branchTip;
    const tagOid = repo.refs.get(`refs/tags/${ref}`);
    if (tagOid) return peelToCommit(this.objects, tagOid);
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) {
      const object = this.objects.get(ref);
      if (object.type === 'commit') return ref;
      return peelToCommit(this.objects, ref);
    }
    return null;
  }

  /**
   * Commit a set of path changes (path -> Buffer content, or null to delete)
   * on top of a branch. Returns the new commit oid. When `baseCommit` is null
   * the commit is a root commit.
   */
  commitChanges(repo, { baseCommit, message, changes }) {
    const flat = new Map(baseCommit ? this.flatten(baseCommit) : []);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.put('blob', content), mode: '100644' });
    }
    const tree = this.buildFromFlat(flat);
    const login = this.viewer();
    const identity = `${login} <${login}@example.invalid>`;
    const data = buildCommit({
      tree,
      parents: baseCommit ? [baseCommit] : [],
      author: identity,
      committer: identity,
      timestamp: this.tick(),
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.put('commit', data);
  }

  /** Commit history from a tip, newest first (DFS pre-order over parents). */
  history(tip, limit = 1000) {
    const out = [];
    const seen = new Set();
    const stack = [tip];
    while (stack.length && out.length < limit) {
      const oid = stack.pop();
      if (!oid || seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo, { title, body = '', labels = [] }) {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `label ${label} does not exist` };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    this.issueSeq += 1;
    const issue = {
      id: this.issueSeq,
      number,
      title,
      body,
      state: 'open',
      labels: labels.map((name) => repo.labels.get(name)),
      comments: [],
      createdAt: this.isoNow(),
    };
    repo.issues.set(number, issue);
    return { issue };
  }

  addComment(repo, issue, body) {
    this.issueSeq += 1;
    const comment = { id: this.issueSeq, body, createdAt: this.isoNow() };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pulls

  createPull(repo, { title, body = '', head, base }) {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (!headTip) return { error: `head branch ${head} does not exist`, status: 422 };
    if (!baseTip) return { error: `base branch ${base} does not exist`, status: 422 };
    for (const pull of repo.pulls.values()) {
      if (pull.headRef === head && pull.baseRef === base && pull.state === 'open') {
        return { error: 'a pull request already exists for this head and base', status: 422 };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    this.issueSeq += 1;
    const pull = {
      id: this.issueSeq,
      number,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: this.isoNow(),
    };
    repo.pulls.set(number, pull);
    return { pull };
  }

  pullHeadSha(repo, pull) {
    return this.branchTip(repo, pull.headRef);
  }

  pullBaseSha(repo, pull) {
    return this.branchTip(repo, pull.baseRef);
  }

  /** Files changed between the pull's merge base and its head tip. */
  pullFiles(repo, pull) {
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    if (!headTip || !baseTip) return [];
    const base = mergeBase(this.objects, baseTip, headTip) ?? baseTip;
    const before = this.flatten(base);
    const after = this.flatten(headTip);
    return diffFlats(before, after, (oid) => this.objects.get(oid));
  }

  /** Whether merging the pull into its base right now would conflict. */
  pullConflict(repo, pull) {
    return this.planMerge(repo, pull).conflict;
  }

  /**
   * A three-way merge plan of the pull into the current base tip.
   * Returns {conflict} or {tree} (the merged flat map).
   */
  planMerge(repo, pull) {
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    if (!headTip || !baseTip) return { conflict: true };
    const ancestor = mergeBase(this.objects, baseTip, headTip);
    const ancestorFlat = ancestor ? this.flatten(ancestor) : new Map();
    const baseFlat = this.flatten(baseTip);
    const headFlat = this.flatten(headTip);
    const merged = new Map(baseFlat);
    const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const a = ancestorFlat.get(path)?.oid ?? null;
      const b = baseFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      if (h === a) continue; // head did not touch it; base's version stands
      if (b === a || b === h) {
        if (h === null) merged.delete(path);
        else merged.set(path, headFlat.get(path));
        continue;
      }
      return { conflict: true };
    }
    return { conflict: false, flat: merged, baseTip };
  }

  /** Squash-merge the pull: one new commit on the base branch with the merged
   *  tree. Returns {sha} or {conflict:true}. */
  mergePull(repo, pull) {
    const plan = this.planMerge(repo, pull);
    if (plan.conflict) return { conflict: true };
    const tree = this.buildFromFlat(plan.flat);
    const login = this.viewer();
    const identity = `${login} <${login}@example.invalid>`;
    const message = `${pull.title}\n\n${pull.body ?? ''}`.trimEnd();
    const data = buildCommit({
      tree,
      parents: [plan.baseTip],
      author: identity,
      committer: identity,
      timestamp: this.tick(),
      message: `${message}\n`,
    });
    const sha = this.put('commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.isoNow();
    pull.mergeCommitSha = sha;
    return { sha };
  }
}

// ---------------------------------------------------------------------------
// tree diffs with line counts

/** A blob as logical lines: a trailing newline terminates the last line. */
function linesOf(buffer) {
  if (!buffer || buffer.length === 0) return [];
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(buffer) {
  return linesOf(buffer).length;
}

/** Line-level add/delete counts between two blobs (LCS on lines, capped). */
function lineDiff(before, after) {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > 4000 || b.length > 4000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: b.length - common, deletions: a.length - common };
}

export function diffFlats(before, after, getObject) {
  const files = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b && a && b.oid === a.oid) continue;
    const beforeData = b ? getObject(b.oid)?.data ?? null : null;
    const afterData = a ? getObject(a.oid)?.data ?? null : null;
    let status;
    let counts;
    if (!b && a) {
      status = 'added';
      counts = { additions: countLines(afterData), deletions: 0 };
    } else if (b && !a) {
      status = 'removed';
      counts = { additions: 0, deletions: countLines(beforeData) };
    } else {
      status = 'modified';
      counts = lineDiff(beforeData, afterData);
    }
    files.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: a ? a.oid : b.oid,
    });
  }
  return files;
}

export { ZERO_OID, isAncestor, parseCommit, parseTag, collectReachable };
