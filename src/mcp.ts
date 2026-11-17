// MCP over Streamable HTTP at /mcp: JSON-RPC 2.0 with the modern
// server/discover negotiation (and the legacy initialize handshake), plus six
// repository tools over the same store the REST API uses. tools/list is
// serialized from one frozen array, so repeated calls are byte-identical.

import { sendJson } from './http.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolSuccess(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function repoPayload(forge, repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${forge.viewer()}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: forge.viewer() },
  };
}

function issuePayload(issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
  };
}

function pullPayload(forge, repo, pull) {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: forge.pullHeadSha(repo, pull) },
    base: { ref: pull.baseRef, sha: forge.pullBaseSha(repo, pull) },
  };
}

/** Resolve the repository a tool call addresses; learns/validates the owner. */
function toolRepo(forge, args) {
  const owner = typeof args.owner === 'string' ? args.owner : forge.viewer();
  forge.learnViewer(owner);
  if (!forge.ownerAllowed(owner)) return null;
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  return forge.repo(name);
}

function missingRequired(tool, args) {
  const required = TOOLS.find((candidate) => candidate.name === tool)?.inputSchema.required ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

function callTool(forge, name, args) {
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(String(args.name), {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private !== false,
      });
      if (repo === null) return { error: 'repository already exists' };
      return { value: repoPayload(forge, repo) };
    }
    case 'get_repo': {
      const repo = toolRepo(forge, args);
      if (!repo) return { error: 'repository not found' };
      return { value: repoPayload(forge, repo) };
    }
    case 'create_issue': {
      const repo = toolRepo(forge, args);
      if (!repo) return { error: 'repository not found' };
      const labels = Array.isArray(args.labels) ? args.labels.filter((l) => typeof l === 'string') : [];
      const result = forge.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        labels,
      });
      if (result.error) return { error: result.error };
      return { value: issuePayload(result.issue) };
    }
    case 'list_issues': {
      const repo = toolRepo(forge, args);
      if (!repo) return { error: 'repository not found' };
      let issues = [...repo.issues.values()];
      const state = typeof args.state === 'string' ? args.state : 'open';
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { value: issues.map(issuePayload) };
    }
    case 'create_pull_request': {
      const repo = toolRepo(forge, args);
      if (!repo) return { error: 'repository not found' };
      const result = forge.createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head ?? ''),
        base: String(args.base ?? repo.defaultBranch),
      });
      if (result.error) return { error: result.error };
      return { value: pullPayload(forge, repo, result.pull) };
    }
    case 'merge_pull_request': {
      const repo = toolRepo(forge, args);
      if (!repo) return { error: 'repository not found' };
      const number = Number(args.pull_number ?? args.number);
      const pull = repo.pulls.get(number);
      if (!pull) return { error: 'pull request not found' };
      if (!pull.merged) {
        if (pull.state !== 'open') return { error: 'pull request is not open' };
        const result = forge.mergePull(repo, pull);
        if (result.conflict) return { error: 'merge conflict' };
      }
      return { value: pullPayload(forge, repo, pull) };
    }
    default:
      return { unknown: true };
  }
}

function handleRpc(forge, message) {
  const id = message && typeof message === 'object' ? message.id : undefined;
  const isNotification = id === undefined || id === null;
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }
  const respond = (payload) => (isNotification ? null : payload);
  switch (message.method) {
    case 'server/discover':
      return respond(rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions: 'A GitHub-compatible forge: repository, issue and pull request tools.',
      }));
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1];
      return respond(rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }));
    }
    case 'ping':
      return respond(rpcResult(id, {}));
    case 'tools/list':
      return respond(rpcResult(id, JSON.parse(TOOLS_LIST_JSON)));
    case 'tools/call': {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (typeof name !== 'string' || !TOOLS.some((tool) => tool.name === name)) {
        return respond(rpcError(id, -32602, `Unknown tool: ${String(name)}`));
      }
      const missing = missingRequired(name, args);
      if (missing.length) {
        return respond(rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`));
      }
      const outcome = callTool(forge, name, args);
      if (outcome.unknown) return respond(rpcError(id, -32602, `Unknown tool: ${name}`));
      if (outcome.error) {
        return respond(rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }],
          isError: true,
        }));
      }
      return respond(rpcResult(id, toolSuccess(outcome.value)));
    }
    default:
      if (message.method.startsWith('notifications/')) return null;
      return respond(rpcError(id, -32601, `Method not found: ${message.method}`));
  }
}

/** Handle POST /mcp. Auth is enforced by the router before this is called. */
export function handleMcp(forge, req, res, rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(payload)) {
    const results = payload.map((message) => handleRpc(forge, message)).filter((result) => result !== null);
    if (results.length === 0) { res.writeHead(202); res.end(); return true; }
    sendJson(res, 200, results);
    return true;
  }
  const result = handleRpc(forge, payload);
  if (result === null) { res.writeHead(202); res.end(); return true; }
  sendJson(res, 200, result);
  return true;
}
