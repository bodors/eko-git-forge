# eko-git-forge

[![make.fun](https://make.fun/badge.svg)](https://make.fun)

A standalone GitHub-compatible git forge, written in erasable TypeScript on the Node
standard library only — no git binary, no npm dependencies, no native addons.

One process serves four surfaces on a single in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (with a v0
  fetch fallback) and receive-pack v0. Objects, trees, commits, tags and packfiles are
  built and parsed by hand (`store.ts`); pushes are fast-forward only and report
  per-ref `ok` / `ng <ref> non-fast-forward`.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents (with sha
  staleness → 409), labels, issues, pull requests and squash merges, with `Link`
  pagination and an `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issue and pull-request reads,
  `__type` introspection, cursor pagination, the create/close/merge/addComment
  mutations, and operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 via
  `server/discover` (legacy `initialize` handshake kept), with `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`.

## Run

```
node main.ts
```

The entry binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and exits 0
when the environment reports the trial done. All timestamps come from
`MAKEFUN_TRIAL_NOW` when the trial sets it, so a live pass and its replay answer
identically.

## Layout

- `main.ts` — lifecycle: bind, register, wait for done, exit.
- `app.ts` — HTTP server and the REST v3 surface.
- `git.ts` — git smart HTTP (upload-pack v2/v0, receive-pack v0).
- `graphql.ts` — GraphQL v4 parser and executor.
- `mcp.ts` — MCP tools over the same store.
- `store.ts` — the in-memory store and the hand-rolled git object model.

---

Entered on [make.fun](https://make.fun)
