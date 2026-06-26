# claude-design

> **Driving this with an AI agent (Claude Code, etc.)?** Install the companion
> skill so the agent knows when and how to use the CLI — auth, sync,
> conflict-safety, and git-backed versioning:
>
> ```bash
> npx skills add mikekelly/claude-design
> ```
>
> The CLI itself needs no install — run it with `npx claude-design …` (or
> `npm i -g claude-design`). See **Install** below.

## Why this exists

**Claude Design has no version history.** The cloud service keeps only a per-file
*concurrency* etag — enough to notice a file changed, never enough to show *what*
changed or to roll back. No revisions, no snapshots, no restore. And the built-in
ways to sync it — the **DesignSync** tool or `claude -p` — run every pull/push
*through an LLM agent*, putting model inference in the critical path: slow,
costly, non-deterministic, and killable on long runs.

`claude-design` exists to fix both — and the first reason is the important one:

- **Versioning, audit & revert — keep the source of truth in git.** The CLI
  mirrors a project down to an ordinary local directory, so you can put that
  directory under version control. That is the *only* way to get history, diffs,
  blame, review, and one-command revert for Claude Design content. Master in the
  cloud instead and an agent can overwrite a critical reference design with **no
  audit trail and no way back** — the cloud has no undo. **Commit your pulls (the
  design files *and* the `.etags` sidecar)** and every sync becomes a restorable,
  reviewable checkpoint. See *Versioning & change-tracking* below.
- **Zero inference in the loop — deterministic & CI-friendly.** Sync is plain
  commands speaking the design MCP wire protocol directly — no model — so it's
  fast, reproducible, and safe to drive from scripts, CI, Makefiles, and git
  hooks. The agent decides *what* to sync; the CLI does the transport.
- **Conflict-safe — never silently clobbers concurrent edits.** A `pull` records
  each file's etag; a `push` guards every write with it, so if the project was
  edited in the Claude Design UI since you pulled, the push is refused (exit `5`)
  rather than overwriting that work.

It mirrors a `claude.ai/design` project down to a local directory and pushes
local changes back up, byte-faithfully.

---

> ## ⚠️ Unofficial, undocumented, unsupported
>
> This is **not affiliated with, endorsed by, or supported by Anthropic.** It
> drives an **undocumented** server-side MCP endpoint, and `claude-design login`
> performs an OAuth flow against Anthropic's **first-party** design OAuth client
> (a public PKCE client id — no secret), so it **presents as a first-party
> client** even though it is unofficial. That endpoint can **change or disappear
> without notice**, which will break this tool. Using a first-party service
> through an unofficial client may also be a **ToS gray area** — use at your own
> risk. If the contract changes, the CLI is designed to **fail loudly** rather
> than corrupt your files, but it will need updating.

---

## Versioning & change-tracking (the recommended workflow)

The single most valuable habit with this CLI: **keep your pulled designs under
git.** Claude Design has no version history of its own, so the git repo around
your synced directory *is* the history — the audit trail and the undo button the
cloud service doesn't provide.

```bash
claude-design pull <project_id> ./design/onboarding
git -C ./design add onboarding && git -C ./design commit -m "design: pull onboarding"
```

- **Commit the design content *and* the `.etags` sidecar together.** Versioning
  `.etags` is part of tracking the design, not an afterthought: each commit then
  captures a coherent snapshot — the exact bytes *and* the etag baseline at that
  sync — so a checkout restores both and the conflict guard stays consistent with
  the content. **Do not `.gitignore` `.etags`.**
- **Audit:** `git log` / `git diff` show how a design changed between syncs —
  including edits made directly in the Claude Design UI, which land as a diff on
  your next `pull`. (Granularity is per-sync, not real-time.)
- **Revert:** `git checkout <rev> -- <path>` then `claude-design push` rolls a
  design back to any previous state — the rollback the cloud can't do for you.
- **Review:** treat design changes like code — branch, open a PR, review the diff
  before pushing to the shared project.

This is the core reason to prefer `claude-design` over the in-agent **DesignSync**
tool: it puts your reference designs under real version control instead of
mastering them in a service that can't undo.

## Install

No install needed — run it with `npx`:

```bash
npx claude-design list
```

Requires **Node ≥ 18** (uses built-in `fetch`). Zero runtime dependencies.

> The command examples below are written as `claude-design …` for brevity. If you
> haven't installed it globally (`npm i -g claude-design`), prefix each with
> `npx ` — e.g. `npx claude-design list`.

## Auth

You need a `claude.ai` login **with design access**. There are two token sources;
the CLI tries them in this order:

1. **The CLI's own OAuth login** (`claude-design login`) — recommended. Stores a
   token at `~/.config/claude-design/credentials.json` (mode `0600`) and
   **auto-refreshes** it when it expires.
2. **Claude Code's existing token** — the macOS **Keychain** entry
   `Claude Code-credentials`, falling back to `~/.claude/.credentials.json`. If
   you've already run `claude` + `/design-login`, the sync commands work without
   a separate `claude-design login`.

**The CLI never prints or logs token values.**

### Logging in (stateless `login` → blocking `monitor-auth`)

Login is split into two plain foreground commands — **no background daemon, no
orphan process.** `login` emits the authorize URL and a short **login id** and
returns immediately; `monitor-auth <id>` binds the loopback callback port and
**blocks** until the browser redirect completes. The loopback listener lives
*only* inside `monitor-auth` — the command the agent is actively awaiting (the
idiomatic `gh auth login` foreground-loopback pattern, split in two so the URL
surfaces first).

```bash
# 1. Print the authorize URL + a login id, then return (exit 0).
claude-design login
#   https://claude.com/cai/oauth/authorize?...        <- open this in a browser
#   open this URL to approve, then run `claude-design monitor-auth a1b2c3d4` ...

# 2. IMMEDIATELY run monitor-auth — it binds the port and BLOCKS until done.
claude-design monitor-auth a1b2c3d4    # exit 0 = authenticated, 20 = failed/timeout
#   (now open the URL and sign in; monitor-auth returns when the callback lands)
```

> **Ordering rule (agents):** run `monitor-auth` *immediately* after surfacing
> the URL, so the loopback port is already listening before the user clicks
> approve. `monitor-auth` blocks (default ~300s; override with `--timeout <sec>`
> or `CLAUDE_DESIGN_MONITOR_TIMEOUT=<sec>`) — an agent simply awaits it.

If the port can't be bound when `monitor-auth` starts (a rare race — another
process grabbed it after `login` released it), it exits `20` with a clear
"re-run login" message.

### Manual (headless / SSH) login

If there's no browser on the same host for the loopback callback, use the paste
fallback:

```bash
claude-design login --manual         # prints a URL; sign in, copy the shown code
claude-design login --code <code>    # complete the login with that code
```

### Check / clear auth

```bash
claude-design whoami    # instant, non-blocking: exit 0 = authed, 4 = not authed
claude-design logout    # clears the CLI's stored token + any pending login
```

`whoami` reads the stored token (refreshing it if expired) and prints one line —
`authenticated[ as <account>]`, `expired`, or `not authenticated` — and **never**
the token value.

### Exit codes

| Command / situation                                   | Exit | Meaning                                  |
| ----------------------------------------------------- | ---- | ---------------------------------------- |
| `login` — URL + id emitted                            | `0`  | done (now run `monitor-auth`)            |
| `monitor-auth` / `login --code` — authenticated       | `0`  | token stored                             |
| `monitor-auth` — timed out / bad state / port unavail | `20` | failed — re-run `claude-design login`    |
| `login --code` — no manual login in progress          | `2`  | usage error                              |
| `whoami` — authenticated                              | `0`  | a usable token is available              |
| `whoami` — not authenticated / expired                | `4`  | run `claude-design login`                |
| any sync command — no valid token available           | `4`  | not authenticated — run `... login`      |
| `push` — remote changed since your last pull (conflict)| `5`  | re-pull and reapply, or push `--force`   |
| `push` — writes landed but a delete failed (partial)  | `1`  | re-run `push` to finish the delete(s)    |
| any command — bad usage                               | `2`  | usage error                              |
| any command — generic failure / contract drift        | `1` / `3` | failure (see message)               |

## Usage

### List your projects

```bash
claude-design list
# <project_id>	<name>
```

### Pull a project down (DOWN mirror)

Mirrors a project into `<dir>` so the directory is an **exact copy** of the
project: every file is written byte-faithfully at its relative path, and local
files that no longer exist upstream are deleted.

> **⚠️ Caution — `pull` overwrites local changes.** It is a destructive
> down-mirror: it overwrites files in `<dir>` and deletes local files that no
> longer exist upstream. **Commit or stash any local edits first** — uncommitted
> changes in `<dir>` are lost. Best practice: keep `<dir>` in git and commit each
> pull (see *Versioning & change-tracking*).

```bash
claude-design pull <project_id> ./design/onboarding
```

- Skips tool-managed artifacts (`*.thumbnail`, `*.design-canvas.state.json`).
- Never deletes a local `PROVENANCE.md` / `CANONICAL.md` sidecar.
- **Fails loudly** (non-zero exit) if any file hits the 256 KiB read cap — it
  reports which files and does **not** write a possibly-truncated copy.
- Writes a `.etags` **base-index sidecar** (see below) recording the etag of
  every file it pulls, so a later `push` can detect upstream changes.

### Push local changes up (UP mirror)

Computes added/changed files (compared against the remote) and files removed
locally, then applies them as a single plan.

```bash
claude-design push <project_id> ./design/onboarding
claude-design push <project_id> ./design/onboarding --force   # last-write-wins
```

- Never deletes tool-managed artifacts upstream (additive safety).
- Flags any local file too large for an inline write (≥ 256 KiB).
- **Conflict-safe when a `.etags` is present** (i.e. the dir came from a `pull`).
  Each write is guarded with a per-file `if_match` equal to the etag recorded at
  pull time; new files use a create-only sentinel. If the remote changed since
  your last pull — a write whose etag moved, or a delete target whose etag moved
  — the push is **refused atomically** (nothing is written), the conflicting
  paths are named, and the CLI exits `5`. Re-pull and reapply, or pass `--force`.
- After a successful push the `.etags` index is **refreshed** from the etags the
  server returns, so consecutive pushes (without an intervening pull) work.
- Push applies writes **then** deletes (writes-first: a delete failure can never
  lose written data). The `.etags` index is refreshed for the written files
  immediately after the writes land — *before* the deletes — so if a delete then
  fails, the push reports a **partial application** (exit `1`) and a re-run
  converges: the landed writes are already recorded (no stale `if_match`, no
  false conflict) and only the pending delete(s) are retried.
- `--force` bypasses all conflict checks (omits `if_match`, skips the delete
  guard) for explicit last-write-wins. It still refreshes `.etags`.

### Resolving a push conflict

If `push` exits `5`, the remote changed since your last pull and **nothing was
written** — your local files are intact. Resolve it with git rather than reaching
for `--force` (which would discard the upstream edit):

1. **Record local state** — commit your edits before the next step overwrites them:
   ```bash
   git -C <dir> add . && git -C <dir> commit -m "wip: local design edits (pre-reconcile)"
   ```
2. **Pull the cloud's current version** (a destructive overwrite — hence step 1
   first; it also refreshes `.etags` to match upstream):
   ```bash
   claude-design pull <project_id> <dir>   # commit this too
   ```
3. **Reconcile** your changes with the upstream ones using `git` (`diff` / `merge`,
   or cherry-pick your edits back onto the pulled state).
4. **Push** the reconciled result — `claude-design push <project_id> <dir>` now
   succeeds, since `.etags` matches upstream.

Use `--force` only for a deliberate last-write-wins (local overwrites upstream),
and only after committing the upstream state in git so it stays recoverable.

### The `.etags` base-index sidecar

`pull` writes a `.etags` file at the root of `<dir>`: a flat JSON map of
`{ "<relative-path>": "<etag>" }` for every text file it mirrored, sourced from
each file's `read_file` response (so the recorded etag exactly matches the bytes
on disk). It is **CLI-local metadata and is never synced** — `push` never
uploads it, `pull` never deletes it, and it is never indexed in itself. Its
presence is what opts a directory into conflict-safe `push`; if it is absent
(e.g. a hand-built dir that was never pulled), `push` falls back to the original
last-write-wins behavior. **Commit it alongside the design content** (don't
`.gitignore` it): versioning the sidecar with the files captures the etag
baseline at each sync, so the history is a coherent, restorable snapshot — see
*Versioning & change-tracking* above.

### Create a project

```bash
claude-design create "My New Project"
# { "project_id": "...", "url": "..." }
```

### Serve a pulled project locally (with live-reload)

A pulled Claude Design project can't be opened as `file://` — its HTML loads
screens via `<script type="text/babel" src="screens/*.jsx">` and
Babel-standalone XHR-fetches those local `.jsx` files, which Chrome blocks
under `file://`. `serve` closes the loop: `pull` → `serve` → view + live-edit.

```bash
claude-design serve ./design/onboarding
# http://localhost:4321
#   http://localhost:4321/TinyTill%20Screens.html
# serving ./design/onboarding (live-reload on) — press Ctrl-C to stop
```

- **Default port is `4321`.** Override with `--port <n>`; `--port 0` lets the OS
  pick a free port (the actual port is always printed).
- **No auto-open** by default (agent-friendly — the agent surfaces the URL).
  Pass `--open` to launch the default browser.
- **Live-reload is on by default.** The server watches `<dir>` recursively and
  pushes an SSE reload event to every connected browser tab when any file
  changes. Pass `--no-reload` to disable it.
- **Zero runtime dependencies.** Uses only Node built-ins (`http`, `fs`, `path`).
- **Path-traversal safe.** Requests that escape `<dir>` are rejected with `403`.
- Serves the correct `Content-Type` for `.html`, `.css`, `.js`, `.mjs`, `.jsx`,
  `.json`, `.svg`, `.png`, `.jpg`, `.gif`, `.webp`, and falls back to
  `application/octet-stream`.

```
claude-design serve <dir> [--port <n>] [--open] [--no-reload]
```

## Limitations

- **Text only — binary files do not round-trip.** The endpoint can only mirror
  UTF-8 text faithfully. `read_file` **refuses to return binary files at all**
  (it errors: *"…is a binary file (stored base64); read_file only returns text
  content"*), and there is no blob-download tool. `write_files` also rejects
  unrecognized binary content types (e.g. `application/octet-stream`). So the CLI
  treats any non-UTF-8 file as un-mirrorable: `push` **skips** it (and exits
  non-zero with a list), and `pull` **skips** any binary file already in the
  project (reporting it, exit 0). Text files around it still sync normally.
  Round-trip fidelity for text is exact — HTML special chars, literal `&amp;` /
  `&lt;` / `&gt;` entities, Unicode, and the presence/absence of a trailing
  newline are all preserved byte-for-byte.
- **256 KiB cap.** The underlying `read_file` (and inline `write_files`) tool
  caps file bodies at 256 KiB. Larger files are reported and skipped rather than
  silently truncated. (Server-side `copy_files` could move large assets but is
  not wired up in this v1.)
- **Token refresh:** a token obtained via `claude-design login` is
  **auto-refreshed** transparently before each call when it has expired (using
  its refresh token). If the refresh token itself is rejected (`invalid_grant`),
  the CLI fails with a clear "run `claude-design login`" message. The **Keychain
  fallback** token (from `claude` / `/design-login`) is **not** refreshed by this
  CLI — if it has expired, re-authenticate via `claude` and `/design-login`, or
  switch to `claude-design login`.
- **macOS-Keychain-first fallback.** Token discovery prefers the CLI's own token,
  then the macOS Keychain, then `~/.claude/.credentials.json`. Other secure
  stores are not consulted. (The `security` CLI resolves the login keychain
  relative to `$HOME`.)
- **Undocumented contract.** See the disclaimer above — the endpoint and tool
  schemas are not a public API.

## License

MIT — see [LICENSE](./LICENSE).
