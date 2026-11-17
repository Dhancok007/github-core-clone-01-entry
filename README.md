# Forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dhancok007/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dhancok007/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)


One standalone Node.js process (standard library only, no dependencies) that
serves four GitHub-compatible surfaces over a single in-memory store:

- **Git smart HTTP** — `/{owner}/{repo}.git/info/refs`, `git-upload-pack`,
  `git-receive-pack`. Protocol v2 (`ls-refs`, `fetch` with shallow/deepen,
  incremental object transfer) and protocol v0 for stock git clients. The git
  object model, packfile reader/writer (including ofs/ref deltas) and
  pkt-line framing are implemented from scratch — no `git` binary is needed
  or used.
- **REST v3** — `/api/v3`: repositories (CRUD, list with `Link` pagination),
  branches and git refs, commit history, contents (read/write/delete with
  git blob ids), labels, issues and comments, pull requests with file diffs
  and squash merges.
- **GraphQL** — `/api/graphql`: `viewer`, `repository` (fields, issue and
  pull-request connections with cursor pagination), `node(id:)` global ids,
  `__type` introspection for the core types, batching, and the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
  mutations.
- **MCP** — `/mcp`: JSON-RPC 2.0 Streamable HTTP with `server/discover`
  negotiation and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) over the same
  store as the REST API.

Authentication is a single bearer token (`MAKEFUN_SHOP_TOKEN`) on the REST,
GraphQL and MCP surfaces; repositories belong to the token's owner, learned
from the first owner-addressed request.

## Start

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port on 127.0.0.1, reports it to
`$MAKEFUN_ENV_URL/register` as `{"port": N}`, serves until the harness
reports `{"done": true}` from `$MAKEFUN_ENV_URL/done`, and exits 0. Without
`MAKEFUN_ENV_URL` it serves standalone (the port is printed on stdout).

Requires Node.js 22 or newer. State is in memory and starts empty; API-side
commits use deterministic timestamps so replays produce identical object ids.

## Layout

- `main.ts` — process lifecycle (bind, register, done-poll, exit)
- `app.ts` — HTTP routing and bearer auth
- `src/gitstore.ts` — git objects, packfiles, pkt-lines, reachability
- `src/store.ts` — forge state: repos, refs, trees, issues, pulls, merges
- `src/githttp.ts` — smart HTTP protocol (advertise, ls-refs, fetch, push)
- `src/rest.ts` — REST v3 routes
- `src/graphql.ts` — GraphQL parser and executor
- `src/mcp.ts` — MCP JSON-RPC endpoint and tools
