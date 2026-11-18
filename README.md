# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/youngzim/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/youngzim/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

**A GitHub-compatible git forge in a single Node process, standard library only.** It serves
four surfaces over one shared in-memory store, so an object created on any surface is the same
object on all of them:

- **Git smart HTTP** at `/<owner>/<repo>.git` — `info/refs`, `git-upload-pack` and
  `git-receive-pack` implemented from the wire up: pkt-lines, packfiles (plain objects out,
  plain + OFS/REF deltas in), protocol v2 (capability advertisement, `ls-refs`, `fetch` with
  shallow/deepen support), the v0 fetch fallback, and v0 receive-pack with `report-status`,
  side-band-64k, delete-refs and fast-forward-only ref updates.
- **REST v3** under `/api/v3` — repositories, contents (create/update/delete with sha checks),
  branches, commits, git refs, labels, issues, comments and pull requests (files diff and
  merge/squash/rebase merges with three-way conflict detection), GitHub-shaped JSON, status
  codes, `Link` pagination and `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql` — a small purpose-built engine (lexer, parser, resolvers)
  for the documents `gh` and `github-mcp-server` actually send: viewer/repository/issue/
  pull-request reads, cursor-paginated issue connections, the create/close/merge/add-comment
  mutations, Relay global ids, operation batching and the `__type` introspection probes.
- **MCP** at `/mcp` — JSON-RPC 2.0 streamable HTTP speaking the 2026-07-28 revision
  (`server/discover`) and the legacy `initialize` handshake, with ten tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, …)
  acting on the same store the REST surface reads.

Authentication is the contest's shop token: every surface except `/healthz` requires
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`, and repositories belong to the login the token
names (the same name under another owner is a 404, never a 403). State is in memory only —
the trial is one fresh process, and the design trades persistence for speed on the timed
read/write/push/clone workloads.

Locally graded with the kit's own conformance suite (`sdk/run.ts` and the sealed
`program/env/server.mjs`): **120/120 checks pass** (git 30/30, repos 15/15, issues 15/15,
pulls 20/20, graphql 20/20, mcp 15/15, protocol 5/5). See `BUILD_REPORT.md` for the full
breakdown and the benchmark medians.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle from the contest starter, unchanged: it binds an ephemeral
port, registers it with `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` and
exits 0 when the trial is over. The server itself is `app.ts` plus the surface modules
(`gitproto.ts`, `rest.ts`, `graphql.ts`, `mcp.ts`) over the shared core in `store.ts`.
Node 22.18+ (type stripping), no dependencies, no install step.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
