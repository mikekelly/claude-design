# claude-design

## Why this exists

Claude Design sync normally runs *through an LLM agent* (the DesignSync tool, or
`claude -p`) — putting model inference in the critical path of every pull/push:
slow, costly, non-deterministic, and killable on long runs. `claude-design`
exposes the same sync as plain deterministic commands, so **scripts, CI,
Makefiles, and git hooks can manage syncing with zero inference in the loop.**
The agent decides *what* to sync; the CLI does the transport.

It mirrors a `claude.ai/design` project down to a local directory and pushes
local changes back up, byte-faithfully, speaking the design MCP wire protocol
directly — no model in the loop.

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

```bash
claude-design pull <project_id> ./design/onboarding
```

- Skips tool-managed artifacts (`*.thumbnail`, `*.design-canvas.state.json`).
- Never deletes a local `PROVENANCE.md` / `CANONICAL.md` sidecar.
- **Fails loudly** (non-zero exit) if any file hits the 256 KiB read cap — it
  reports which files and does **not** write a possibly-truncated copy.

### Push local changes up (UP mirror)

Computes added/changed files (compared against the remote) and files removed
locally, then applies them as a single plan.

```bash
claude-design push <project_id> ./design/onboarding
```

- Never deletes tool-managed artifacts upstream (additive safety).
- Flags any local file too large for an inline write (≥ 256 KiB).

### Create a project

```bash
claude-design create "My New Project"
# { "project_id": "...", "url": "..." }
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
