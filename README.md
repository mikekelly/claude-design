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

## Auth prerequisite

You need a `claude.ai` login **with design access**. Authenticate once:

```bash
claude            # start Claude Code
/design-login     # then run this slash command to log in to the design service
```

The CLI reads your token from the macOS **Keychain** entry
`Claude Code-credentials`, falling back to `~/.claude/.credentials.json` on
other platforms. **It never prints or logs your token.**

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
- **No token refresh yet.** If your OAuth token has expired, the CLI fails with
  a clear message — re-authenticate by running `claude` and `/design-login`. It
  does not attempt an automatic refresh in v1.
- **macOS-Keychain-first.** Token discovery prefers the macOS Keychain, then
  `~/.claude/.credentials.json`. Other secure stores are not consulted.
- **Undocumented contract.** See the disclaimer above — the endpoint and tool
  schemas are not a public API.

## License

MIT — see [LICENSE](./LICENSE).
