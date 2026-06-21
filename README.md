# claude-design

A tiny, dependency-free CLI to **sync design assets to and from Claude's design
service** (`claude.ai/design`) deterministically — no LLM in the loop. It mirrors
a design project down to a local directory and pushes local changes back up,
byte-faithfully.

---

> ## ⚠️ Unofficial, undocumented, unsupported
>
> This is **not affiliated with, endorsed by, or supported by Anthropic.** It
> drives an **undocumented** server-side MCP endpoint by reusing your local
> `claude.ai` OAuth token. That endpoint can **change or disappear without
> notice**, which will break this tool. Using a first-party service through an
> unofficial client may also be a **ToS gray area** — use at your own risk. If
> the endpoint's contract changes, the CLI is designed to **fail loudly** rather
> than corrupt your files, but it will need updating.

---

## What it does

It speaks the MCP wire protocol (streamable HTTP) directly against the design
endpoint, authenticating with the OAuth token Claude Code already stored on your
machine. There is **no model inference** — every operation is a deterministic
file diff/copy. It is meant for keeping a repo's design-reference directory in
exact sync with its canonical `claude.ai/design` project.

## Install

No install needed — run it with `npx`:

```bash
npx claude-design list
```

Requires **Node ≥ 18** (uses built-in `fetch`). Zero runtime dependencies.

## Auth

You need a `claude.ai` login **with design access**. There are two ways to get a
token; the CLI tries them in this order:

1. **The CLI's own OAuth login** (`claude-design login`) — recommended. Stores a
   token at `~/.config/claude-design/credentials.json` (mode `0600`) and
   **auto-refreshes** it when it expires.
2. **Claude Code's existing token** — the macOS **Keychain** entry
   `Claude Code-credentials`, falling back to `~/.claude/.credentials.json`. This
   fallback is unchanged: if you've already run `claude` + `/design-login`, the
   sync commands work without a separate `claude-design login`.

**The CLI never prints or logs token values.**

> ### ⚠️ Standalone login presents as Anthropic's first-party design client
>
> `claude-design login` performs an OAuth PKCE flow against Anthropic's design
> OAuth client (a **public** client id — no secret). It therefore **presents as
> a first-party Anthropic client** even though this tool is **unofficial and
> unsupported**. Using a first-party service through an unofficial client may be
> a **ToS gray area** — use at your own risk. Prefer the Keychain fallback (auth
> via the official `claude` / `/design-login`) if you'd rather not run the
> standalone login.

### Logging in (agent-friendly, non-blocking poll flow)

`login` is built for an AI agent to orchestrate. It does **not** block waiting
for the browser — it returns the authorize URL immediately and runs the callback
listener in a detached background process. The agent then polls `auth-check`:

```bash
# 1. Start login — prints an authorize URL and returns immediately (exit 0).
claude-design login
#   https://claude.com/cai/oauth/authorize?...   <- open this in a browser
#   Open this URL ... then poll `claude-design auth-check` ...

# 2. Open the URL, sign in. Meanwhile, poll auth-check until it stops being pending:
claude-design auth-check        # exit 10 = pending, 0 = authenticated, 20 = failed/timeout
```

`auth-check` is designed to be polled in a loop (with the agent's own timeout)
until it returns `0` or `20`. It also transparently refreshes the stored token
if it has expired. The detached listener self-times-out after ~5 minutes.

**Exit codes:**

| Command / situation                         | Exit | Meaning                                  |
| ------------------------------------------- | ---- | ---------------------------------------- |
| `auth-check` — authenticated (token valid)  | `0`  | done                                     |
| `auth-check` — listener still waiting       | `10` | pending — keep polling                   |
| `auth-check` — failed / timed out / no login| `20` | failed — re-run `claude-design login`    |
| any sync command — no valid token available | `4`  | not authenticated — run `... login`      |

### Manual (headless / SSH) login

If there's no browser on the same host for the loopback callback, use the paste
fallback:

```bash
claude-design login --manual         # prints a URL; sign in, copy the shown code
claude-design login --code <code>    # complete the login with that code
```

### Logging out

```bash
claude-design logout                 # clears the CLI's stored token + any pending login
```

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
- **macOS-Keychain-first.** Token discovery prefers the macOS Keychain, then
  `~/.claude/.credentials.json`. Other secure stores are not consulted.
- **Undocumented contract.** See the disclaimer above — the endpoint and tool
  schemas are not a public API.

## License

MIT — see [LICENSE](./LICENSE).
