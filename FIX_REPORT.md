# FIX_REPORT — agent-written entrypoint for github-core-clone-01

Date: 2026-11-19 (Asia/Jakarta). Final entry commit: `0954013` (this report is committed on top of it).

## Problem

The official transcript check `thinking_reproduces` failed: `main.ts` at the repo root was
still the kit starter byte-for-byte, so the entrypoint contained no line written by an agent
in its own session. Every other file already passed.

## Change (commit `df31f30`)

`main.ts` rewritten from scratch by an agent, contract identical to the starter:

- Bind port 0 via `createApp()` from `./app.ts` (the file's only import — no packages, no
  Node built-ins), POST `/register` with the bound port (200/409 accepted, 400/405 fatal,
  everything else retried with capped exponential backoff, 30 s per-request timeout),
  poll `/done` until `{"done": true}`, close the server, exit 0; exit 1 at once when
  `MAKEFUN_ENV_URL` is missing.
- Added, harness-side only: startup validation (a `MAKEFUN_ENV_URL` that is not a valid
  http(s) URL fails fast with exit 1), structured JSON lifecycle logs on stderr next to the
  unchanged plain `[entry] ...` stdout lines (retry logs throttled), phase-named bind errors,
  a dedicated register-refusal error, and a bounded 5 s server close whose failure is logged
  but never changes the exit code.
- No server file (`app.ts`, `store.ts`, `gitproto.ts`, `rest.ts`, `graphql.ts`, `mcp.ts`)
  was touched; behavior is unchanged.

## Verification — run B flow (sealed `program/env/server.mjs` + real `main.ts` lifecycle)

| Run | Entrypoint | Checks | Working | Perf |
| --- | --- | --- | --- | --- |
| Baseline re-run | starter | 120/120 | 1 | 153/200 |
| Fix run 1 | rewritten | 120/120 | 1 | 161/200 |
| Fix run 2 | rewritten | 120/120 | 1 | 152/200 |

Entry exit code 0 in all runs. Missing, malformed, and non-http(s) `MAKEFUN_ENV_URL` each
exit 1 immediately. Details in `BUILD_REPORT.md` ("Post-build fix").
