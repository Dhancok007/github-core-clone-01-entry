// GitHub REST v3: the /api/v3 surface. Repositories, branches, commits,
// contents, labels, issues, comments and pull requests over the shared store.
//
// Ownership: repositories belong to the token's login. That login is learned
// from the first owner-addressed request (the suite always addresses the
// viewer's repositories first); a repository name under any other owner is a
// 404, never a 403. Requests without the bearer token are 401.

import { parseCommit, parseTree } from './gitstore.ts';
import { parseJsonBody, sendError, sendJson } from './http.ts';

const SCOPES = { 'x-oauth-scopes': 'repo, read:org' };

function repoJson(forge, repo) {
  const owner = forge.viewer();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1, type: 'User' },
    html_url: `http://forge.local/${owner}/${repo.name}`,
    clone_url: `http://forge.local/${owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label) {
  return { name: label.name, color: label.color, description: null, default: false };
}

function issueJson(forge, repo, issue) {
  const owner = forge.viewer();
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    html_url: `http://forge.local/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(forge, comment) {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.viewer(), id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function pullJson(forge, repo, pull) {
  const owner = forge.viewer();
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: owner, id: 1, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: forge.pullHeadSha(repo, pull),
      label: `${owner}:${pull.headRef}`,
      repo: { name: repo.name, full_name: `${owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: forge.pullBaseSha(repo, pull),
      label: `${owner}:${pull.baseRef}`,
      repo: { name: repo.name, full_name: `${owner}/${repo.name}` },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    html_url: `http://forge.local/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(forge, oid) {
  const object = forge.get(oid);
  const commit = parseCommit(object.data);
  const authorLine = commit.author;
  const match = /^(.*) <(.*)> (\d+) /.exec(authorLine);
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: match ? { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() } : { name: '', email: '', date: '' },
      committer: match ? { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() } : { name: '', email: '', date: '' },
    },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

function pagination(url) {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const pageRaw = Number(url.searchParams.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function pageSlice(items, { perPage, page }) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function linkHeader(req, url, total, { perPage, page }) {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
  const make = (p) => {
    const params = new URLSearchParams(url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${base}?${params.toString()}>`;
  };
  const parts = [];
  if (page < lastPage) parts.push(`${make(page + 1)}; rel="next"`, `${make(lastPage)}; rel="last"`);
  if (page > 1) parts.push(`${make(1)}; rel="first"`, `${make(page - 1)}; rel="prev"`);
  return parts.length ? { link: parts.join(', ') } : {};
}

/** Handle one /api/v3 request. Returns true when the route was claimed. */
export function handleRest(forge, req, res, url, rawBody) {
  const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  // segments: ['api', 'v3', ...]
  const rest = segments.slice(2);
  const method = req.method;

  const body = () => parseJsonBody(res, rawBody);
  const notFound = () => { sendError(res, 404, 'Not Found'); return true; };

  // ---- root and meta
  if (rest.length === 0) {
    if (method !== 'GET') return notFound();
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
    }, SCOPES);
    return true;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false }, SCOPES);
    return true;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: forge.viewer(), id: 1, type: 'User', name: forge.viewer() }, SCOPES);
    return true;
  }

  // ---- the viewer's repository list / creation
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const paging = pagination(url);
      const all = forge.repoList().map((repo) => repoJson(forge, repo));
      sendJson(res, 200, pageSlice(all, paging), { ...SCOPES, ...linkHeader(req, url, all.length, paging) });
      return true;
    }
    if (method === 'POST') {
      const data = body();
      if (data === undefined) return true;
      const name = typeof data.name === 'string' ? data.name : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendError(res, 422, 'Repository name is invalid');
        return true;
      }
      const repo = forge.createRepo(name, {
        description: typeof data.description === 'string' ? data.description : '',
        isPrivate: data.private !== false,
      });
      if (repo === null) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      sendJson(res, 201, repoJson(forge, repo), SCOPES);
      return true;
    }
    return notFound();
  }

  // ---- repository-scoped routes
  if (rest[0] !== 'repos' || rest.length < 3) return notFound();
  const owner = rest[1];
  const repoName = rest[2];
  forge.learnViewer(owner);
  if (!forge.ownerAllowed(owner)) return notFound();
  const repo = forge.repo(repoName);
  if (repo === null) return notFound();
  const sub = rest.slice(3);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  if (sub.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(forge, repo), SCOPES); return true; }
    if (method === 'PATCH') {
      const data = body();
      if (data === undefined) return true;
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.private = data.private;
      if (typeof data.name === 'string' && data.name !== repo.name && !forge.repo(data.name)) {
        forge.repos.delete(repo.name);
        repo.name = data.name;
        forge.repos.set(repo.name, repo);
      }
      sendJson(res, 200, repoJson(forge, repo), SCOPES);
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repoName);
      res.writeHead(204, { 'x-github-request-id': 'forge-del' });
      res.end();
      return true;
    }
    return notFound();
  }

  // ---- branches and refs
  if (sub[0] === 'branches' && sub.length === 1 && method === 'GET') {
    const branches = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches, SCOPES);
    return true;
  }
  if (sub[0] === 'branches' && sub.length === 2 && method === 'GET') {
    const tip = forge.branchTip(repo, sub[1]);
    if (!tip) return notFound();
    sendJson(res, 200, { name: sub[1], commit: { sha: tip } }, SCOPES);
    return true;
  }
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (sub.length === 2 && method === 'POST') {
      const data = body();
      if (data === undefined) return true;
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      const object = forge.get(sha);
      if (!ref.startsWith('refs/') || !object || object.type !== 'commit') {
        sendError(res, 422, 'Invalid ref or sha');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } }, SCOPES);
      return true;
    }
    if (sub.length >= 3 && method === 'GET') {
      const ref = `refs/${sub.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) return notFound();
      sendJson(res, 200, { ref, object: { sha: oid, type: forge.get(oid)?.type ?? 'commit' } }, SCOPES);
      return true;
    }
    return notFound();
  }

  // ---- commits
  if (sub[0] === 'commits' && sub.length === 1 && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveRef(repo, ref);
    if (!tip) { sendJson(res, 200, [], SCOPES); return true; }
    const paging = pagination(url);
    const all = forge.history(tip).map((oid) => commitJson(forge, oid));
    sendJson(res, 200, pageSlice(all, paging), { ...SCOPES, ...linkHeader(req, url, all.length, paging) });
    return true;
  }

  // ---- contents
  if (sub[0] === 'contents') {
    const filePath = sub.slice(1).join('/');
    return contentsRoute(forge, req, res, url, repo, filePath, rawBody);
  }

  // ---- labels
  if (sub[0] === 'labels' && sub.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson), SCOPES);
      return true;
    }
    if (method === 'POST') {
      const data = body();
      if (data === undefined) return true;
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') { sendError(res, 422, 'Label name is required'); return true; }
      if (repo.labels.has(name)) { sendError(res, 422, 'Label already exists'); return true; }
      const label = { name, color: typeof data.color === 'string' ? data.color.replace(/^#/, '') : 'ededed' };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label), SCOPES);
      return true;
    }
    return notFound();
  }

  // ---- issues and comments
  if (sub[0] === 'issues') {
    return issuesRoute(forge, req, res, url, repo, sub.slice(1), rawBody);
  }

  // ---- pulls
  if (sub[0] === 'pulls') {
    return pullsRoute(forge, req, res, url, repo, sub.slice(1), rawBody);
  }

  return notFound();
}

function contentsRoute(forge, req, res, url, repo, filePath, rawBody) {
  const method = req.method;
  const refParam = url.searchParams.get('ref');

  if (method === 'GET') {
    const commitOid = forge.resolveRef(repo, refParam ?? undefined);
    if (!commitOid) return sendError(res, 404, 'Not Found'), true;
    const flat = forge.flatten(commitOid);
    const entry = flat.get(filePath);
    if (entry) {
      const object = forge.get(entry.oid);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        name: filePath.split('/').pop(),
        path: filePath,
        sha: entry.oid,
        size: object.data.length,
        content: object.data.toString('base64'),
      });
      return true;
    }
    // directory listing: entries directly under filePath (or root)
    const prefix = filePath === '' ? '' : `${filePath}/`;
    const commit = forge.get(commitOid);
    const treeOid = treeAtPath(forge, parseCommit(commit.data).tree, filePath);
    if (treeOid === null && filePath !== '') { sendError(res, 404, 'Not Found'); return true; }
    const entries = [];
    if (treeOid !== null) {
      for (const child of parseTree(forge.get(treeOid).data)) {
        const isDir = child.mode === '40000';
        const childObject = forge.get(child.oid);
        entries.push({
          type: isDir ? 'dir' : 'file',
          name: child.name,
          path: prefix + child.name,
          sha: child.oid,
          size: isDir ? 0 : childObject.data.length,
        });
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, entries);
    return true;
  }

  if (method === 'PUT') {
    const data = parseJsonBody(res, rawBody);
    if (data === undefined) return true;
    const message = typeof data.message === 'string' ? data.message : 'Update file';
    const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
    let content;
    try {
      content = Buffer.from(typeof data.content === 'string' ? data.content : '', 'base64');
    } catch {
      sendError(res, 422, 'content is not valid base64');
      return true;
    }
    let tip = forge.branchTip(repo, branch);
    if (!tip) {
      // A contents write on an unknown branch creates it from the default
      // branch (or as a root commit on an unborn repository).
      tip = forge.branchTip(repo, repo.defaultBranch);
    }
    const flat = tip ? forge.flatten(tip) : new Map();
    const existing = flat.get(filePath);
    if (existing && typeof data.sha === 'string' && data.sha !== existing.oid) {
      sendError(res, 409, 'The sha does not match the current file');
      return true;
    }
    if (existing && data.sha === undefined) {
      sendError(res, 422, 'sha is required to update an existing file');
      return true;
    }
    const blobOid = forge.put('blob', content);
    const commitOid = forge.commitChanges(repo, {
      baseCommit: tip,
      message,
      changes: new Map([[filePath, content]]),
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    sendJson(res, existing ? 200 : 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, encoding: 'base64', type: 'file', size: content.length },
      commit: { sha: commitOid },
    });
    return true;
  }

  if (method === 'DELETE') {
    const data = parseJsonBody(res, rawBody);
    if (data === undefined) return true;
    const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    if (!tip) { sendError(res, 404, 'Not Found'); return true; }
    const flat = forge.flatten(tip);
    const existing = flat.get(filePath);
    if (!existing) { sendError(res, 404, 'Not Found'); return true; }
    if (typeof data.sha === 'string' && data.sha !== existing.oid) {
      sendError(res, 409, 'The sha does not match the current file');
      return true;
    }
    const commitOid = forge.commitChanges(repo, {
      baseCommit: tip,
      message: typeof data.message === 'string' ? data.message : 'Delete file',
      changes: new Map([[filePath, null]]),
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    sendJson(res, 200, { content: null, commit: { sha: commitOid } });
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

/** Walk a tree by path; returns the subtree oid, the tree itself for '', or null. */
function treeAtPath(forge, rootTreeOid, path) {
  if (path === '') return rootTreeOid;
  let current = rootTreeOid;
  for (const segment of path.split('/')) {
    const tree = forge.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

function issuesRoute(forge, req, res, url, repo, rest, rawBody) {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      if (sort === 'created' && direction === 'desc') issues.reverse();
      const paging = pagination(url);
      const all = issues.map((issue) => issueJson(forge, repo, issue));
      sendJson(res, 200, pageSlice(all, paging), linkHeader(req, url, all.length, paging));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, rawBody);
      if (data === undefined) return true;
      const labels = Array.isArray(data.labels) ? data.labels.filter((l) => typeof l === 'string') : [];
      const result = forge.createIssue(repo, {
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
        labels,
      });
      if (result.error) { sendError(res, 422, result.error); return true; }
      sendJson(res, 201, issueJson(forge, repo, result.issue));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue) { sendError(res, 404, 'Not Found'); return true; }

  if (rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, issueJson(forge, repo, issue)); return true; }
    if (method === 'PATCH') {
      const data = parseJsonBody(res, rawBody);
      if (data === undefined) return true;
      if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      if (Array.isArray(data.labels)) {
        const names = data.labels.filter((l) => typeof l === 'string');
        for (const name of names) {
          if (!repo.labels.has(name)) { sendError(res, 422, `label ${name} does not exist`); return true; }
        }
        issue.labels = names.map((name) => repo.labels.get(name));
      }
      sendJson(res, 200, issueJson(forge, repo, issue));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (rest[1] === 'comments') {
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(forge, comment)));
      return true;
    }
    if (rest.length === 2 && method === 'POST') {
      const data = parseJsonBody(res, rawBody);
      if (data === undefined) return true;
      const comment = forge.addComment(repo, issue, typeof data.body === 'string' ? data.body : '');
      sendJson(res, 201, commentJson(forge, comment));
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function pullsRoute(forge, req, res, url, repo, rest, rawBody) {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const paging = pagination(url);
      const all = pulls.map((pull) => pullJson(forge, repo, pull));
      sendJson(res, 200, pageSlice(all, paging), linkHeader(req, url, all.length, paging));
      return true;
    }
    if (method === 'POST') {
      const data = parseJsonBody(res, rawBody);
      if (data === undefined) return true;
      const result = forge.createPull(repo, {
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
        head: typeof data.head === 'string' ? data.head : '',
        base: typeof data.base === 'string' ? data.base : repo.defaultBranch,
      });
      if (result.error) { sendError(res, result.status ?? 422, result.error); return true; }
      sendJson(res, 201, pullJson(forge, repo, result.pull));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull) { sendError(res, 404, 'Not Found'); return true; }

  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(forge, repo, pull));
    return true;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    }));
    sendJson(res, 200, files);
    return true;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const data = parseJsonBody(res, rawBody);
    if (data === undefined) return true;
    if (pull.merged) { sendError(res, 405, 'Pull request has already been merged'); return true; }
    if (pull.state !== 'open') { sendError(res, 405, 'Pull request is not open'); return true; }
    const result = forge.mergePull(repo, pull);
    if (result.conflict) { sendError(res, 405, 'Pull request is not mergeable: merge conflict'); return true; }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}
