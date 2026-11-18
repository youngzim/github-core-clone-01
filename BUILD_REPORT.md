# BUILD_REPORT — github-core-clone-01

Entry code commit: `ee328ccaf25c41e3bbba920112102ac99e534dfb` (this report is committed on top of it).
Built 2026-11-19 (Asia/Jakarta) against the official kit in
`~/workspace/makefun/kits/github-core-clone-01/` and the competition requirements endpoint.
**Not submitted to Make.fun by the builder** — submission is centralized with the main agent.

## What was built

A GitHub-compatible git forge as a single Node process, standard library only
(`node:http`, `node:zlib`, `node:crypto`), no dependencies, no git binary, all state in memory.
The starter's `main.ts` lifecycle is byte-identical to the kit's; the server is new:

| File | Role |
| --- | --- |
| `main.ts` | Harness lifecycle (kit starter, unchanged): bind port 0, POST `/register`, poll `/done`, exit 0 |
| `app.ts` | HTTP wiring: bearer-token gate (`MAKEFUN_SHOP_TOKEN`), `X-GitHub-Request-Id` on every reply, routing, 500-proofing |
| `store.ts` | Shared core: SHA-1 object store, trees/commits, ancestry + merge-base, three-way tree merge, repos/issues/PRs/labels/comments, LCS line diffs |
| `gitproto.ts` | Git smart HTTP: pkt-lines, pack write (plain) + pack read (plain, OFS/REF deltas, trailer verified), protocol v2 advertisement/ls-refs/fetch with shallow + deepen, v0 fetch fallback, receive-pack v0 with report-status in side-band-64k, fast-forward-only branch updates (`ng <ref> non-fast-forward`) |
| `rest.ts` | REST v3: repos CRUD + `Link` pagination, contents (201/200/409 sha semantics), branches, commits log, git refs, labels, issues + comments, PRs (files diff, merge/squash/rebase via PUT `/pulls/{n}/merge`, 405 on conflict), protocol-correct error bodies |
| `graphql.ts` | Purpose-built GraphQL engine (lexer/parser/executor): the exact `gh`/`github-mcp-server` documents — viewer, repository fields, issue/PR reads, cursor connections (`first`/`after`, `states`, `orderBy`), create/close issue, create/merge PR, add comment, Relay global ids (base64, opaque, stable), `node(id:)`, batching (array body → array of results), `__type` introspection for Issue/PullRequest/Repository/SearchType |
| `mcp.ts` | MCP over streamable HTTP: `server/discover` (2026-07-28) plus the legacy `initialize` handshake, 10 tools with object schemas (byte-identical `tools/list`), `-32602` for unknown tools and missing arguments, HTTP 400 + `-32700` for non-JSON bodies, tools acting on the same store as REST |

Design choices worth knowing:

- One shared store for all four surfaces is what makes the cross-surface checks (GraphQL↔REST,
  MCP↔REST parity) hold by construction.
- The token's viewer is the contest scenario's fixed identity (`adaiversen`, id 1000); any other
  owner segment is a 404, never a 403, per the rules.
- Issues and pull requests share one per-repo number counter (GitHub semantics); repos start
  with **no** labels (the suite creates the labels it uses and expects 201).
- Timestamps are a deterministic monotone clock derived from a creation sequence, so ordering
  checks never depend on wall time.
- Packs are written undeltified; the trial client accepts plain objects and the workloads are
  small. Pack *reading* fully resolves OFS/REF deltas for pushes that do deltify.

## Local test results (real numbers, run 2026-11-19)

Two independent local runs of the kit's own suite, both against a fresh server process:

**Run A — `sdk/run.ts --perf` (the kit's local runner): 120/120 checks passed.**

| Group | Passed |
| --- | --- |
| git | 30/30 |
| repos | 15/15 |
| issues | 15/15 |
| pulls | 20/20 |
| graphql | 20/20 |
| mcp | 15/15 |
| protocol | 5/5 |
| **Total** | **120/120 → feature 600, agent 200** |

Benchmark medians in that run (this shared 1.5-CPU VM, other agents active; T_ref = the house
reference's production medians from the kit's `calibration.json`):

| Workload | Local p50 | T_ref | Points |
| --- | --- | --- | --- |
| push (200× receive-pack) | 624 ms | 1641 ms | 42/50 |
| clone (50× concurrent depth-1) | 188 ms | 267 ms | 31/50 |
| read (2000× GET issue) | 1512 ms | 2760 ms | 36/50 |
| write (200× POST issue) | 186 ms | 349 ms | 36/50 |
| **Perf total** | | | **145/200** |

**Run B — the sealed env itself (`program/env/server.mjs`) driving the real `main.ts`
lifecycle** (register → suite → `/done` → entry exits 0): `state.json` reports **120/120 passed,
working 1**; `perf.json` reports **149/200** (push p50 696 ms → 40, clone 174 ms → 33,
read 1286 ms → 39, write 178 ms → 37). Local score estimate across runs: **945–949 / 1000**.

Caveats, honestly: local hardware is not the trial pod (2 CPU / 1024 MiB, gVisor, shared
production nodes), so perf points will move; the conformance suite is byte-identical to the
sealed one, so the 120/120 is the strongest signal. The only failure seen during development
was a GraphQL parser bug (an unconsumed `:` in variable definitions) that failed 14 GraphQL
checks on the first run; fixed and re-verified at 120/120 twice.

## Not implemented / deliberate limits

- No persistence: state dies with the process (the trial is one fresh process; nothing in the
  suite rewards persistence).
- Git: no pack delta *writing* (plain objects only), no partial-clone `filter` support (not
  advertised, so the suite never requests it), no `deepen-since`/`deepen-not` usage in the
  suite (implemented best-effort), no SSH transport (not part of the contest surface).
- GraphQL: only the schema subset the suite's documents touch (no search, no reviews, no
  label connections); unknown fields answer GitHub-style errors, as the suite requires.
- REST: no rate-limit headers (the rules say none are required), no repo rename, no webhooks.

## Repository state

- `.makefun/owner.json` holds exactly `{"wallet": "gvrTcc2MArPCYo1RGXYCKQAykuRRTUSzJksuJziT2gP"}`.
- `LICENSE` is the kit starter's MIT license (OSI-approved).
- `README.md` follows the official requirements template (three make.fun badges for
  github-core-clone-01/youngzim/github-core-clone-01 + the bounty link).
- Source size: ~147 KB total across 7 TypeScript files (limit is 16 MiB); erasable-syntax-only
  TypeScript for Node's type stripping (no enums, namespaces or parameter properties).
