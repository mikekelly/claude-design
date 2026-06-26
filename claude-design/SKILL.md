---
name: claude-design
description: "Drive the claude-design CLI for deterministic, inference-free Claude Design sync (pull/push/list/create). Use when you need to mirror a Claude Design project to/from a local directory, resolve a project UUID, or script repeatable sync in CI — without putting model inference in the loop. Prefer this over routing sync through the DesignSync MCP tool or claude -p whenever the work is scriptable, repeatable, or CI-driven."
compatibility: "Requires Node >=18. Run via npx claude-design or install globally. macOS Keychain fallback requires macOS."
license: MIT
---

<objective>
Drive claude-design to sync Claude Design projects deterministically — no LLM inference in the transport path. The agent decides *what* to sync; the CLI does the transport.
</objective>

<warning>
**Unofficial and unsupported.** claude-design speaks an undocumented Anthropic endpoint and performs OAuth as Anthropic's first-party design client (public PKCE client — no secret). The endpoint can change or disappear without notice. Using a first-party service through an unofficial client is a ToS gray area. The CLI is designed to fail loudly rather than corrupt files, but it will need updating if the contract drifts.
</warning>

<quick_start>
```bash
# Check auth first
npx claude-design whoami          # exit 0 = authed, 4 = not authed

# List projects → get UUID
npx claude-design list            # prints: <uuid>  <name>

# Pull a project down
npx claude-design pull <uuid> ./design/my-project

# Push local changes up
npx claude-design push <uuid> ./design/my-project

# Create a new project
npx claude-design create "My Project Name"
```
</quick_start>

<auth_flow>
## Auth precedence (auto-resolved by all sync commands)

1. CLI's own token at `~/.config/claude-design/credentials.json` (auto-refreshed on expiry)
2. macOS Keychain `Claude Code-credentials` fallback (from running `claude` + `/design-login`)
3. If neither → exits **4** → run the login flow below

## Login flow (loopback, browser on same host)

**Critical ordering rule: run `monitor-auth` IMMEDIATELY after surfacing the URL** — it binds the loopback port. The port must be listening before the user clicks approve.

```bash
# Step 1: get URL + login id (returns immediately, no daemon)
npx claude-design login
# prints:
#   https://claude.com/cai/oauth/authorize?...   ← surface this to the user
#   open this URL to approve, then run `claude-design monitor-auth <id>` ...

# Step 2: IMMEDIATELY run this — it BLOCKS until the callback lands (exit 0) or times out (exit 20)
npx claude-design monitor-auth <id>
# Default timeout: ~5 min. Override: --timeout <sec> or CLAUDE_DESIGN_MONITOR_TIMEOUT=<sec>

# Step 3: retry the original command
```

## Headless / SSH (no browser on this host)

```bash
npx claude-design login --manual     # prints a URL; user opens it, copies the code shown
npx claude-design login --code <code>  # complete the login
```

## Clear auth

```bash
npx claude-design logout   # clears stored token + any pending login
```
</auth_flow>

<commands>
## Project discovery

```bash
npx claude-design list
# Output: <uuid>  <name>   (one project per line)
```

Resolve a project name → UUID from `list`. Only ask the user to paste a design URL when the target is **not listed** (e.g., shared with them via link only). The `project_id` is the UUID after `/p/` in `https://claude.ai/design/p/<uuid>`.

## Pull (DOWN mirror)

```bash
npx claude-design pull <project_id> <dir>
```

- Exact down-mirror: writes every remote file byte-faithfully, deletes local files no longer upstream
- Skips tool-managed artifacts (`.thumbnail`, `.design-canvas.state.json`)
- Never deletes local `PROVENANCE.md` or `CANONICAL.md` sidecars
- Binary files: **skipped and reported** (endpoint only returns text via `read_file`); exit 0 still
- Files ≥ 256 KiB: **not written**, reported loudly → exit **2**
- Writes a `.etags` base-index sidecar recording each file's etag → enables conflict-safe push

## Push (UP mirror)

```bash
npx claude-design push <project_id> <dir>
npx claude-design push <project_id> <dir> --force   # last-write-wins, no conflict checks
```

- Uploads added/changed text files; deletes remote files removed locally
- Never deletes tool-managed artifacts upstream
- Non-UTF-8 (binary) files: **skipped and reported** → exit **2** if any skipped
- Files ≥ 256 KiB: **fails loudly before writing anything** → exit **2**
- **Conflict-safe when a `.etags` is present** (dir came from a `pull`): each write is guarded by a per-file `if_match` (the pull-time etag; new files use a `"0"` create-only sentinel), and delete targets are checked for upstream drift. If the remote changed since your last pull, the push is **refused atomically** (nothing written), conflicting paths are named, and it exits **5** — re-pull and reapply, or pass `--force`.
- `.etags` is **refreshed** from the server's returned etags after a successful push, so consecutive pushes (no intervening pull) work.
- No `.etags` present → falls back to the original last-write-wins behavior (no `if_match` sent).

## The `.etags` sidecar

- A flat JSON `{ "<rel-path>": "<etag>" }` map written at the root of `<dir>` by `pull`.
- **CLI-local metadata, never synced**: never pushed up, never pulled down, never deleted by a mirror, never indexed in itself.
- Its presence opts a directory into conflict-safe `push`; its absence keeps last-write-wins.

## Create

```bash
npx claude-design create "Project Name"
# Output: { "project_id": "...", "url": "..." }
```
</commands>

<exit_codes>
| Exit | Meaning | Action |
|------|---------|--------|
| `0` | Success | — |
| `2` | Usage error or oversized/binary files flagged | Fix args or check file size |
| `4` | Not authenticated | Run the login flow |
| `5` | `push` conflict: remote changed since your last pull | Re-pull and reapply, or `push --force` |
| `20` | Auth failed / timed out / port unavailable | Re-run `claude-design login` and repeat |
| `1`/`3` | Generic failure / contract drift | Read the message; CLI may need updating |
</exit_codes>

<limitations>
- **Text only.** Binary files cannot round-trip. `read_file` refuses them; `write_files` rejects unrecognized binary types. Any non-UTF-8 file is skipped.
- **256 KiB cap.** Both read and write are capped. Files at or above this limit are reported and skipped rather than silently truncated.
- **Undocumented contract.** The endpoint and tool schemas are not a public API and can change without notice.
- **macOS Keychain fallback is not auto-refreshed** by this CLI — if it expires, re-authenticate via `claude` + `/design-login`, or use `claude-design login`.
- **Token stored at** `~/.config/claude-design/credentials.json` (mode 0600). Never printed.
</limitations>

<success_criteria>
- `whoami` exits 0 before attempting sync
- `list` resolves the project UUID without asking the user to paste a URL
- `pull`/`push` exits 0 with a clear file count summary
- On exit 4: login flow completed with `monitor-auth` run immediately after surfacing the URL
- On exit 20: re-ran `claude-design login` and repeated the `monitor-auth` step
</success_criteria>
