# claude-design — agent orientation

Unofficial, **inference-free** CLI that mirrors a `claude.com/design` project to/from
a local directory by driving Claude Code's undocumented Design MCP endpoint. No LLM,
no subagents — deterministic sync only. Entry point: `bin/claude-design.mjs`
(single file; `bin/serve.mjs` is the live-reload static server).

- Tests: `npm test` (uses `node --test`). Tests drive the **real CLI** as a
  subprocess against **local stub servers** for the OAuth token endpoint
  (`CLAUDE_DESIGN_TOKEN_URL`) and the design MCP endpoint (`CLAUDE_DESIGN_MCP_URL`),
  with `HOME` redirected to a temp dir. Extend the stub harness in
  `test/etags-conflict.test.mjs` / `test/mcp-session.test.mjs` rather than inventing
  a new one.
- User-facing docs: `README.md` and `claude-design/SKILL.md` (keep exit-code tables
  and the pull/push behavior in sync with the code).

## Conflict-safe push (`.etags` base index) — load-bearing rules

`push` is opt-in **detect-and-refuse-on-conflict** via a CLI-local `.etags` sidecar
(`{ "<rel-posix-path>": "<etag>" }`) at the dir root. Three rules are load-bearing —
breaking any reintroduces a silent-overwrite or false-conflict bug:

1. **Etags are captured from the per-file `read_file` response, never `list_files`.**
   `list_files` runs before the per-file reads; a web-UI edit in that window would
   desync the recorded etag from the bytes written to disk → false conflict later.
   `read_file` carries content+etag atomically. See `extractEtag()`.
2. **`if_match` comes from `.etags` (pull/last-push time), never a push-time
   `read_file`.** A push-time etag reflects current remote and would only guard the
   useless read→write window.
3. **`.etags` is refreshed from `write_files`' returned `etags` after a successful
   push** (not only on pull). Without this, a second consecutive push sends stale
   `if_match` and gets a false conflict because the CLI itself moved the remote.

Other invariants: `.etags` is **never synced** (never pushed/pulled/deleted — see
`shouldSkip`/`isProtectedLocal`/`ETAGS_FILE`). Absent `.etags` ⇒ original
last-write-wins (backwards-compatible default). `--force` bypasses all guards.
Delete-drift: `delete_files` has no `if_match`, so push compares each delete
target's current `list_files` etag against the `.etags` base and refuses on drift.
Conflict ⇒ exit code **5** (`EXIT.conflict`).

**Unverified against the live endpoint:** the `write_files` conflict-response shape
(`{ status:"conflict", conflicts:[{path, etag, content_omitted}] }`) is modeled from
the task spec / live tool description, not confirmed against the real server.
