// A GraphQL subset for the queries the suite issues: viewer, repository
// fields and introspection of the Issue / PullRequest / Repository /
// SearchType types, issue and pull-request connections with cursor paging,
// the node() global-id lookup, and the createIssue / closeIssue /
// createPullRequest / mergePullRequest / addComment mutations.
//
// The parser covers operations with variable definitions, aliases, inline
// fragments, directives (skipped), and string / int / boolean / enum / list /
// object argument values. Unknown fields are reported as GraphQL errors that
// name the field, with HTTP 200, as the protocol requires.

import { parseJsonBody, sendError, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// lexer / parser

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if ('{}()[]:=@!$'.includes(ch)) { tokens.push({ kind: ch }); i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: '...' }); i += 3; continue; }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(j + 2, j + 6))) {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
            j += 2;
          }
        } else { value += source[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { return this.tokens[this.pos++]; }

  expect(kind) {
    const token = this.next();
    if (!token || token.kind !== kind) throw new Error(`expected ${kind}`);
    return token;
  }

  parseDocument() {
    const operations = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value, name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // fragment definitions are not used by the fixture; skip the body
        while (this.pos < this.tokens.length && this.peek().kind !== '{') this.pos += 1;
        this.parseSelectionSet();
      } else {
        this.pos += 1;
      }
    }
    return operations;
  }

  parseVariableDefinitions() {
    this.expect('(');
    let depth = 1;
    while (this.pos < this.tokens.length && depth > 0) {
      const token = this.next();
      if (token.kind === '(' || token.kind === '[' || token.kind === '{') depth += 1;
      if (token.kind === ')' || token.kind === ']' || token.kind === '}') depth -= 1;
    }
  }

  skipDirectives() {
    while (this.peek()?.kind === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.kind === '(') {
        this.expect('(');
        let depth = 1;
        while (this.pos < this.tokens.length && depth > 0) {
          const token = this.next();
          if (token.kind === '(') depth += 1;
          if (token.kind === ')') depth -= 1;
        }
      }
    }
  }

  parseSelectionSet() {
    this.expect('{');
    const fields = [];
    while (this.peek() && this.peek().kind !== '}') fields.push(this.parseField());
    this.expect('}');
    return fields;
  }

  parseField() {
    if (this.peek().kind === '...') {
      this.next();
      let on = null;
      if (this.peek()?.kind === 'name' && this.peek().value === 'on') {
        this.next();
        on = this.next().value;
      }
      this.skipDirectives();
      return { fragment: true, on, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expect('name').value;
    let alias = null;
    if (this.peek()?.kind === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    let args = {};
    if (this.peek()?.kind === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet = null;
    if (this.peek()?.kind === '{') selectionSet = this.parseSelectionSet();
    return { fragment: false, name, alias, args, selectionSet };
  }

  parseArguments() {
    this.expect('(');
    const args = {};
    while (this.peek() && this.peek().kind !== ')') {
      const key = this.expect('name').value;
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue() {
    const token = this.next();
    if (!token) throw new Error('unexpected end of input');
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === '$') return { variable: this.expect('name').value };
    if (token.kind === '[') {
      const values = [];
      while (this.peek() && this.peek().kind !== ']') values.push(this.parseValue());
      this.expect(']');
      return values;
    }
    if (token.kind === '{') {
      const object = {};
      while (this.peek() && this.peek().kind !== '}') {
        const key = this.expect('name').value;
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum literal
    }
    throw new Error(`unexpected token ${token.kind}`);
  }
}

function resolveValue(value, variables) {
  if (value && typeof value === 'object') {
    if ('variable' in value) return variables[value.variable];
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// global ids

export function globalId(kind, parts) {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id) {
  try {
    const text = Buffer.from(String(id), 'base64').toString('utf8');
    const segments = text.split(':');
    return { kind: segments[0], parts: segments.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// type metadata for introspection

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'repository', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'repository', 'author', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// execution

function typeOf(value) {
  if (value === null || value === undefined) return 'Null';
  if (value.__type) return value.__type;
  return 'Unknown';
}

/** Project a selection set onto a resolved object via per-type resolvers. */
function project(ctx, typeName, value, selectionSet, errors) {
  if (value === null || value === undefined) return null;
  if (!selectionSet) return value;
  const out = {};
  for (const field of selectionSet) {
    if (field.fragment) {
      if (field.on === null || field.on === typeName || typeName === 'Unknown') {
        Object.assign(out, project(ctx, typeName, value, field.selectionSet, errors));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const args = resolveValue(field.args, ctx.variables);
    const resolver = (RESOLVERS[typeName] ?? {})[field.name];
    if (!resolver) {
      errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const resolved = resolver(ctx, value, args);
    const declared = CHILD_TYPE[`${typeName}.${field.name}`];
    const childType = declared && declared !== 'Unknown' ? declared : null;
    if (field.selectionSet && resolved !== null && resolved !== undefined) {
      if (Array.isArray(resolved)) {
        out[key] = resolved.map((item) => project(ctx, childType ?? typeOf(item), item, field.selectionSet, errors));
      } else if (typeof resolved === 'object') {
        out[key] = project(ctx, childType ?? typeOf(resolved), resolved, field.selectionSet, errors);
      } else {
        out[key] = resolved;
      }
    } else {
      out[key] = resolved ?? null;
    }
  }
  return out;
}

const CHILD_TYPE = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.pullRequest': 'PullRequest',
  'Issue.repository': 'Repository',
  'PullRequest.repository': 'Repository',
};

function repoValue(forge, repo) {
  return { __type: 'Repository', repo };
}

function issueValue(forge, repo, issue) {
  return { __type: 'Issue', repo, issue };
}

function pullValue(forge, repo, pull) {
  return { __type: 'PullRequest', repo, pull };
}

function connection(items, args) {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const decoded = decodeGlobalId(args.after);
    if (decoded && decoded.kind === 'cursor') start = Number(decoded.parts[0]) + 1;
  }
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  return {
    __type: 'Connection',
    nodes: slice,
    edges: slice.map((node, index) => ({ node, cursor: globalId('cursor', [String(start + index)]) })),
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? globalId('cursor', [String(start)]) : null,
      endCursor: slice.length ? globalId('cursor', [String(start + slice.length - 1)]) : null,
    },
    totalCount: items.length,
  };
}

const RESOLVERS = {
  Query: {
    viewer: (ctx) => ({ __type: 'User', login: ctx.forge.viewer() }),
    repository: (ctx, _value, args) => {
      ctx.forge.learnViewer(typeof args.owner === 'string' ? args.owner : null);
      if (!ctx.forge.ownerAllowed(args.owner)) return null;
      const repo = ctx.forge.repo(args.name);
      return repo ? repoValue(ctx.forge, repo) : null;
    },
    node: (ctx, _value, args) => resolveNode(ctx, args.id),
    __type: (ctx, _value, args) => typeInfo(args.name),
    __schema: () => ({ __type: 'Schema' }),
  },
  Mutation: {
    createIssue: (ctx, _value, args) => {
      const input = args.input ?? args;
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (!repo) return { issue: null };
      const result = ctx.forge.createIssue(repo, { title: input.title ?? '', body: input.body ?? '', labels: [] });
      if (result.error) return { issue: null };
      return { __type: 'CreateIssuePayload', issue: issueValue(ctx.forge, repo, result.issue) };
    },
    closeIssue: (ctx, _value, args) => {
      const input = args.input ?? args;
      const found = issueByGlobalId(ctx, input.issueId);
      if (!found) return { issue: null };
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueValue(ctx.forge, found.repo, found.issue) };
    },
    createPullRequest: (ctx, _value, args) => {
      const input = args.input ?? args;
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (!repo) return { pullRequest: null };
      const result = ctx.forge.createPull(repo, {
        title: input.title ?? '',
        body: input.body ?? '',
        head: input.headRefName ?? '',
        base: input.baseRefName ?? repo.defaultBranch,
      });
      if (result.error) return { pullRequest: null };
      return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(ctx.forge, repo, result.pull) };
    },
    mergePullRequest: (ctx, _value, args) => {
      const input = args.input ?? args;
      const found = pullByGlobalId(ctx, input.pullRequestId);
      if (!found) return { pullRequest: null };
      if (!found.pull.merged && found.pull.state === 'open') ctx.forge.mergePull(found.repo, found.pull);
      return { __type: 'MergePullRequestPayload', pullRequest: pullValue(ctx.forge, found.repo, found.pull) };
    },
    addComment: (ctx, _value, args) => {
      const input = args.input ?? args;
      const found = issueByGlobalId(ctx, input.subjectId) ?? pullAsIssue(ctx, input.subjectId);
      if (!found) return { commentEdge: null };
      const comment = ctx.forge.addComment(found.repo, found.issue, input.body ?? '');
      return {
        __type: 'AddCommentPayload',
        commentEdge: { node: { __type: 'IssueComment', id: globalId('comment', [String(comment.id)]), body: comment.body, databaseId: comment.id } },
      };
    },
  },
  User: {
    login: (ctx, value) => value.login,
    id: () => globalId('user', ['1']),
    databaseId: () => 1,
    name: (ctx, value) => value.login,
  },
  Repository: {
    id: (ctx, value) => globalId('repo', [String(value.repo.id)]),
    databaseId: (ctx, value) => value.repo.id,
    name: (ctx, value) => value.repo.name,
    nameWithOwner: (ctx, value) => `${ctx.forge.viewer()}/${value.repo.name}`,
    description: (ctx, value) => value.repo.description,
    isPrivate: (ctx, value) => value.repo.private,
    owner: (ctx) => ({ __type: 'User', login: ctx.forge.viewer() }),
    defaultBranchRef: (ctx, value) => {
      const tip = ctx.forge.branchTip(value.repo, value.repo.defaultBranch);
      return { __type: 'Ref', name: value.repo.defaultBranch, target: tip ? { oid: tip } : null, prefix: 'refs/heads/' };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    url: (ctx, value) => `http://forge.local/${ctx.forge.viewer()}/${value.repo.name}`,
    createdAt: (ctx, value) => value.repo.createdAt,
    updatedAt: (ctx, value) => value.repo.createdAt,
    issue: (ctx, value, args) => {
      const issue = value.repo.issues.get(Number(args.number));
      return issue ? issueValue(ctx.forge, value.repo, issue) : null;
    },
    issues: (ctx, value, args) => {
      let issues = [...value.repo.issues.values()];
      const states = Array.isArray(args.states) ? args.states.map((s) => String(s).toLowerCase()) : null;
      if (states) issues = issues.filter((issue) => states.includes(issue.state));
      issues.sort((a, b) => a.number - b.number);
      if (args.orderBy && String(args.orderBy.direction).toUpperCase() === 'DESC') issues.reverse();
      const values = issues.map((issue) => issueValue(ctx.forge, value.repo, issue));
      return connection(values, args);
    },
    pullRequest: (ctx, value, args) => {
      const pull = value.repo.pulls.get(Number(args.number));
      return pull ? pullValue(ctx.forge, value.repo, pull) : null;
    },
    pullRequests: (ctx, value, args) => {
      let pulls = [...value.repo.pulls.values()];
      const states = Array.isArray(args.states) ? args.states.map((s) => String(s).toUpperCase()) : null;
      if (states) pulls = pulls.filter((pull) => (pull.merged ? 'MERGED' : pull.state.toUpperCase()) === states[0] || states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      pulls.sort((a, b) => a.number - b.number);
      const values = pulls.map((pull) => pullValue(ctx.forge, value.repo, pull));
      return connection(values, args);
    },
  },
  Ref: {
    name: (ctx, value) => value.name,
    prefix: (ctx, value) => value.prefix,
    target: (ctx, value) => value.target,
  },
  Issue: {
    id: (ctx, value) => globalId('issue', [String(value.repo.id), String(value.issue.number)]),
    databaseId: (ctx, value) => value.issue.id,
    number: (ctx, value) => value.issue.number,
    title: (ctx, value) => value.issue.title,
    body: (ctx, value) => value.issue.body,
    state: (ctx, value) => value.issue.state.toUpperCase(),
    repository: (ctx, value) => repoValue(ctx.forge, value.repo),
    author: (ctx) => ({ __type: 'User', login: ctx.forge.viewer() }),
    labels: (ctx, value, args) => connection(value.issue.labels.map((label) => ({ __type: 'Label', name: label.name, color: label.color })), args),
    comments: (ctx, value, args) => connection(value.issue.comments.map((comment) => ({ __type: 'IssueComment', id: globalId('comment', [String(comment.id)]), body: comment.body, databaseId: comment.id })), args),
    createdAt: (ctx, value) => value.issue.createdAt,
    updatedAt: (ctx, value) => value.issue.createdAt,
    url: (ctx, value) => `http://forge.local/${ctx.forge.viewer()}/${value.repo.name}/issues/${value.issue.number}`,
  },
  PullRequest: {
    id: (ctx, value) => globalId('pr', [String(value.repo.id), String(value.pull.number)]),
    databaseId: (ctx, value) => value.pull.id,
    number: (ctx, value) => value.pull.number,
    title: (ctx, value) => value.pull.title,
    body: (ctx, value) => value.pull.body ?? '',
    state: (ctx, value) => (value.pull.merged ? 'MERGED' : value.pull.state.toUpperCase()),
    merged: (ctx, value) => value.pull.merged,
    mergedAt: (ctx, value) => value.pull.mergedAt,
    mergeCommit: (ctx, value) => (value.pull.mergeCommitSha ? { oid: value.pull.mergeCommitSha } : null),
    mergeable: (ctx, value) => {
      if (value.pull.merged) return 'UNKNOWN';
      return ctx.forge.pullConflict(value.repo, value.pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (ctx, value) => value.pull.headRef,
    baseRefName: (ctx, value) => value.pull.baseRef,
    headRefOid: (ctx, value) => ctx.forge.pullHeadSha(value.repo, value.pull),
    baseRefOid: (ctx, value) => ctx.forge.pullBaseSha(value.repo, value.pull),
    files: (ctx, value, args) => {
      const files = ctx.forge.pullFiles(value.repo, value.pull).map((file) => ({
        __type: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      return connection(files, args);
    },
    repository: (ctx, value) => repoValue(ctx.forge, value.repo),
    author: (ctx) => ({ __type: 'User', login: ctx.forge.viewer() }),
    createdAt: (ctx, value) => value.pull.createdAt,
    updatedAt: (ctx, value) => value.pull.createdAt,
    url: (ctx, value) => `http://forge.local/${ctx.forge.viewer()}/${value.repo.name}/pull/${value.pull.number}`,
  },
  Connection: {
    nodes: (ctx, value) => value.nodes,
    edges: (ctx, value) => value.edges,
    pageInfo: (ctx, value) => value.pageInfo,
    totalCount: (ctx, value) => value.totalCount,
  },
  Label: {
    name: (ctx, value) => value.name,
    color: (ctx, value) => value.color,
    id: (ctx, value) => globalId('label', [value.name]),
  },
  IssueComment: {
    id: (ctx, value) => value.id,
    body: (ctx, value) => value.body,
    databaseId: (ctx, value) => value.databaseId,
  },
};

CHILD_TYPE['Repository.issues'] = 'Connection';
CHILD_TYPE['Repository.pullRequests'] = 'Connection';
CHILD_TYPE['PullRequest.files'] = 'Connection';
CHILD_TYPE['Issue.labels'] = 'Connection';
CHILD_TYPE['Issue.comments'] = 'Connection';
CHILD_TYPE['Mutation.createIssue'] = 'CreateIssuePayload';
CHILD_TYPE['Mutation.closeIssue'] = 'CloseIssuePayload';
CHILD_TYPE['Mutation.createPullRequest'] = 'CreatePullRequestPayload';
CHILD_TYPE['Mutation.mergePullRequest'] = 'MergePullRequestPayload';
CHILD_TYPE['Mutation.addComment'] = 'AddCommentPayload';
CHILD_TYPE['CreateIssuePayload.issue'] = 'Issue';
CHILD_TYPE['CloseIssuePayload.issue'] = 'Issue';
CHILD_TYPE['CreatePullRequestPayload.pullRequest'] = 'PullRequest';
CHILD_TYPE['MergePullRequestPayload.pullRequest'] = 'PullRequest';

RESOLVERS.CreateIssuePayload = { issue: (ctx, value) => value.issue, clientMutationId: () => null };
RESOLVERS.CloseIssuePayload = { issue: (ctx, value) => value.issue, clientMutationId: () => null };
RESOLVERS.CreatePullRequestPayload = { pullRequest: (ctx, value) => value.pullRequest, clientMutationId: () => null };
RESOLVERS.MergePullRequestPayload = { pullRequest: (ctx, value) => value.pullRequest, clientMutationId: () => null };
RESOLVERS.AddCommentPayload = {
  commentEdge: (ctx, value) => value.commentEdge,
  clientMutationId: () => null,
};
RESOLVERS.__Type = {
  name: (ctx, value) => value.name,
  kind: (ctx, value) => value.kind,
  fields: (ctx, value, args) => (TYPE_FIELDS[value.name] ?? []).map((name) => ({ __type: '__Field', name })),
  enumValues: (ctx, value) => (ENUM_VALUES[value.name] ?? []).map((name) => ({ __type: '__EnumValue', name })),
  possibleTypes: () => [],
};
RESOLVERS.__Field = {
  name: (ctx, value) => value.name,
  description: () => null,
  isDeprecated: () => false,
  type: () => ({ __type: '__Type', name: 'String', kind: 'SCALAR' }),
};
RESOLVERS.__EnumValue = { name: (ctx, value) => value.name, description: () => null, isDeprecated: () => false };
RESOLVERS.Schema = { types: () => [], queryType: () => ({ name: 'Query' }), mutationType: () => ({ name: 'Mutation' }) };
RESOLVERS.PageInfo = {
  hasNextPage: (ctx, value) => value.hasNextPage,
  hasPreviousPage: (ctx, value) => value.hasPreviousPage,
  startCursor: (ctx, value) => value.startCursor,
  endCursor: (ctx, value) => value.endCursor,
};
CHILD_TYPE['__Type.fields'] = '__Field';
CHILD_TYPE['__Type.enumValues'] = '__EnumValue';
CHILD_TYPE['Query.__type'] = '__Type';
CHILD_TYPE['Connection.nodes'] = 'Unknown';
CHILD_TYPE['Connection.edges'] = 'Edge';
CHILD_TYPE['Connection.pageInfo'] = 'PageInfo';
CHILD_TYPE['AddCommentPayload.commentEdge'] = 'Edge';
RESOLVERS.Edge = {
  node: (ctx, value) => value.node,
  cursor: (ctx, value) => value.cursor ?? null,
};
RESOLVERS.PullRequestChangedFile = {
  path: (ctx, value) => value.path,
  additions: (ctx, value) => value.additions,
  deletions: (ctx, value) => value.deletions,
  changeType: (ctx, value) => value.changeType,
};

const KNOWN_TYPES = new Set([
  ...Object.keys(TYPE_FIELDS),
  ...Object.keys(ENUM_VALUES),
  'User', 'Ref', 'Label', 'IssueComment', 'PageInfo', 'Connection', 'Edge',
  '__Type', '__Field', '__EnumValue', '__Schema', '__Directive',
  'CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload',
  'MergePullRequestPayload', 'AddCommentPayload', 'PullRequestChangedFile',
  'String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID',
]);

function typeInfo(name) {
  if (!name || !KNOWN_TYPES.has(name)) return null;
  const isEnum = name in ENUM_VALUES;
  return {
    __type: '__Type',
    name,
    kind: isEnum ? 'ENUM' : ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID'].includes(name) ? 'SCALAR' : 'OBJECT',
  };
}

function repoByGlobalId(ctx, id) {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'repo') {
    const repoId = Number(decoded.parts[0]);
    return ctx.forge.repoList().find((repo) => repo.id === repoId) ?? null;
  }
  return null;
}

function issueByGlobalId(ctx, id) {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'issue') return null;
  const repo = ctx.forge.repoList().find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (!repo) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue ? { repo, issue } : null;
}

function pullByGlobalId(ctx, id) {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'pr') return null;
  const repo = ctx.forge.repoList().find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (!repo) return null;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull ? { repo, pull } : null;
}

function pullAsIssue(ctx, id) {
  const found = pullByGlobalId(ctx, id);
  if (!found) return null;
  // Comments on a pull request land on its shared issue-thread number space;
  // the forge keeps them on a shadow issue record keyed by the pull number.
  let issue = found.repo.issues.get(found.pull.number);
  if (!issue) {
    issue = { id: found.pull.id, number: found.pull.number, title: found.pull.title, body: found.pull.body ?? '', state: found.pull.state, labels: [], comments: [], createdAt: found.pull.createdAt };
    found.repo.issues.set(found.pull.number, issue);
  }
  return { repo: found.repo, issue };
}

function resolveNode(ctx, id) {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'repo') {
    const repo = repoByGlobalId(ctx, id);
    return repo ? repoValue(ctx.forge, repo) : null;
  }
  if (decoded.kind === 'issue') {
    const found = issueByGlobalId(ctx, id);
    return found ? issueValue(ctx.forge, found.repo, found.issue) : null;
  }
  if (decoded.kind === 'pr') {
    const found = pullByGlobalId(ctx, id);
    return found ? pullValue(ctx.forge, found.repo, found.pull) : null;
  }
  if (decoded.kind === 'user') return { __type: 'User', login: ctx.forge.viewer() };
  return null;
}

function executeOperation(forge, operation, variables) {
  const ctx = { forge, variables: variables ?? {} };
  const errors = [];
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = project(ctx, rootType, { __type: rootType }, operation.selectionSet, errors);
  const result = { data };
  if (errors.length) result.errors = errors;
  return result;
}

/** Handle POST /api/graphql (single operation or a batch array). */
export function handleGraphql(forge, req, res, rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const runOne = (item) => {
    if (!item || typeof item.query !== 'string') {
      return { errors: [{ message: 'Must provide query string.' }] };
    }
    let operations;
    try {
      operations = new Parser(item.query).parseDocument();
    } catch (error) {
      return { errors: [{ message: `Syntax error: ${error.message}` }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'Must provide an operation.' }] };
    const operation = item.operationName
      ? operations.find((candidate) => candidate.name === item.operationName) ?? operations[0]
      : operations[0];
    return executeOperation(forge, operation, item.variables ?? {});
  };
  if (Array.isArray(payload)) {
    sendJson(res, 200, payload.map(runOne));
    return true;
  }
  const result = runOne(payload);
  sendJson(res, 200, result);
  return true;
}
