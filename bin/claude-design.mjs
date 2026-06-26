#!/usr/bin/env node
// claude-design — deterministic, inference-free design-asset sync against
// Claude Code's (undocumented) Design MCP endpoint. No LLM, no subagents.
//
// UNOFFICIAL / UNSUPPORTED: this drives an undocumented endpoint. See README.
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
  rmSync, openSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative, sep, posix } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startServer, printBanner } from './serve.mjs';

// CLAUDE_DESIGN_MCP_URL exists only as a test seam (point the design MCP
// endpoint at a local stub); production never sets it.
const ENDPOINT = process.env.CLAUDE_DESIGN_MCP_URL || 'https://api.anthropic.com/v1/design/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const READ_CAP = 256 * 1024; // 256 KiB
const CLIENT = { name: 'claude-design', version: '0.1.3' };

// ---------------------------------------------------------------------------
// OAuth — standalone design login.
//
// These are PUBLIC PKCE client identifiers (no client secret). The "design"
// client + claude.com authorize host grant the user:design:* scopes that the
// /v1/design/mcp endpoint requires. Reverse-engineered & verified; used here so
// the CLI can mint its own token instead of borrowing Claude Code's.
//
// NOTE on impersonation/ToS: this presents as Anthropic's first-party design
// OAuth client. It is unofficial and unsupported (see README disclaimer).
// ---------------------------------------------------------------------------
const AUTH = {
  clientId: '59637612-477b-4836-a601-b0589eda7704',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  // CLAUDE_DESIGN_TOKEN_URL exists only as a test seam (point the token
  // endpoint at a local stub); production never sets it.
  tokenUrl: process.env.CLAUDE_DESIGN_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token',
  scopes: 'user:design:read user:design:write',
  // Loopback success page + manual (paste) redirect target.
  successUrl: 'https://platform.claude.com/oauth/code/success?app=claude-code',
  manualRedirectUri: 'https://platform.claude.com/oauth/code/callback',
};

// Default blocking-wait timeout for `monitor-auth` (ms) and a safety skew for
// expiry checks. The timeout is overridable via --timeout <sec> or
// CLAUDE_DESIGN_MONITOR_TIMEOUT (seconds).
const MONITOR_TIMEOUT_MS = 5 * 60 * 1000; // ~5 min default
const EXPIRY_SKEW_MS = 30 * 1000; // refresh slightly before real expiry
const TOKEN_HTTP_TIMEOUT_MS = 30 * 1000;

// Distinct exit codes the orchestrating agent relies on. Keep STABLE.
const EXIT = {
  ok: 0,
  error: 1, // generic failure
  usage: 2, // bad usage (matches existing push/pull cap-fail convention)
  notAuthenticated: 4, // a command needs auth but no valid token is available
  conflict: 5, // push: remote changed since last pull (etag/if_match mismatch)
  authFailed: 20, // monitor-auth: failed / timed out / bad state
};

// CLI-local base-index sidecar: a flat { "<rel-posix-path>": "<etag>" } map of
// the etags observed at the last pull/push, used as per-file if_match on push to
// detect-and-refuse-on-conflict. It is metadata, NEVER synced in either
// direction (never pushed up, never pulled down, never deleted by a mirror).
const ETAGS_FILE = '.etags';

// Files that are tool-managed artifacts on the design side: never mirror down,
// never delete up.
const SKIP_SUFFIXES = ['.thumbnail', '.design-canvas.state.json'];
// Local-only sidecars we must never delete during a DOWN mirror. The .etags
// base-index is CLI-local metadata and gets the same protection.
const PROTECTED_BASENAMES = ['PROVENANCE.md', 'CANONICAL.md', ETAGS_FILE];

function fail(msg, code = 1) {
  console.error(`claude-design: ${msg}`);
  process.exit(code);
}

function contractDrift(detail) {
  fail(
    `the (undocumented) design MCP contract may have changed — this CLI needs updating.\n  detail: ${detail}`,
    3,
  );
}

// ---------------------------------------------------------------------------
// OAuth: PKCE + authorize URL (pure, no I/O)
// ---------------------------------------------------------------------------
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

function buildAuthorizeUrl({ challenge, state, redirectUri }) {
  const u = new URL(AUTH.authorizeUrl);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', AUTH.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', AUTH.scopes);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}

// ---------------------------------------------------------------------------
// OAuth: CLI-owned token + pending-login storage
// Layout under ~/.config/claude-design/:
//   credentials.json -> { designOauth: { accessToken, refreshToken, expiresAt, scopes } }
//   pending.json     -> { id, verifier, state, port?, redirect_uri, manual, createdAt }
//                       written by `login`, read+deleted by `monitor-auth` / `login --code`
// ---------------------------------------------------------------------------
function configDir({ home = homedir() } = {}) {
  return join(home, '.config', 'claude-design');
}
function credentialsPath(opts) {
  return join(configDir(opts), 'credentials.json');
}
function pendingPath(opts) {
  return join(configDir(opts), 'pending.json');
}

function writeOwnToken(rec, opts) {
  const dir = configDir(opts);
  mkdirSync(dir, { recursive: true });
  const path = credentialsPath(opts);
  // Create with 0600 from the start (openSync mode), then write.
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ designOauth: rec }, null, 2));
  } finally {
    closeSync(fd);
  }
  return path;
}

function readOwnToken(opts) {
  const path = credentialsPath(opts);
  if (!existsSync(path)) return null;
  try {
    const blob = JSON.parse(readFileSync(path, 'utf8'));
    const rec = blob && blob.designOauth;
    if (rec && typeof rec.accessToken === 'string') return rec;
    return null;
  } catch {
    return null;
  }
}

function clearOwnToken(opts) {
  const path = credentialsPath(opts);
  if (existsSync(path)) rmSync(path, { force: true });
}

// Persist the pending-login record (PKCE verifier+state, loopback port/redirect)
// that `monitor-auth` / `login --code` later read to complete the exchange.
// Mode 0600 — it carries the verifier (a bearer-equivalent secret).
function writePending(rec, opts) {
  const dir = configDir(opts);
  mkdirSync(dir, { recursive: true });
  const path = pendingPath(opts);
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(rec, null, 2));
  } finally {
    closeSync(fd);
  }
  return path;
}

function readPending(opts) {
  const path = pendingPath(opts);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function clearPending(opts) {
  const path = pendingPath(opts);
  if (existsSync(path)) rmSync(path, { force: true });
}

// Short, human-typeable login id (8 hex chars).
function makeLoginId() {
  return randomBytes(4).toString('hex');
}

function tokenIsExpired(rec) {
  if (!rec || rec.expiresAt == null) return false; // no expiry info -> assume valid
  const exp = Number(rec.expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp <= Date.now() + EXPIRY_SKEW_MS;
}

// ---------------------------------------------------------------------------
// OAuth: token endpoint (exchange + refresh). Content-Type: application/json
// ONLY — no Authorization/version headers. 30s timeout.
// ---------------------------------------------------------------------------
async function tokenRequest(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(AUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data };
}

function tokenRecordFrom(data, fallbackRefresh) {
  const expiresIn = Number(data.expires_in);
  const expiresAt = Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null;
  return {
    accessToken: data.access_token,
    // If the server omits a new refresh token, keep the old one.
    refreshToken: data.refresh_token || fallbackRefresh || null,
    expiresAt,
    scopes: data.scope || AUTH.scopes,
  };
}

async function exchangeCode({ code, redirectUri, verifier, state }) {
  const { status, data } = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: AUTH.clientId,
    code_verifier: verifier,
    state,
  });
  if (status >= 400 || !data.access_token) {
    const detail = data.error_description || data.error || JSON.stringify(data).slice(0, 200);
    throw new Error(`token exchange failed (HTTP ${status}): ${detail}`);
  }
  return tokenRecordFrom(data, null);
}

// Returns a refreshed token record. Throws a tagged Error('invalid_grant') when
// the refresh token is no longer valid so callers can require re-login.
async function refreshToken(rec) {
  const { status, data } = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: rec.refreshToken,
    client_id: AUTH.clientId,
    scope: AUTH.scopes,
  });
  if (data && data.error === 'invalid_grant') {
    const e = new Error('invalid_grant');
    e.code = 'invalid_grant';
    throw e;
  }
  if (status >= 400 || !data.access_token) {
    const detail = data.error_description || data.error || JSON.stringify(data).slice(0, 200);
    throw new Error(`token refresh failed (HTTP ${status}): ${detail}`);
  }
  return tokenRecordFrom(data, rec.refreshToken);
}

// Resolve a usable access token from the CLI's OWN store, refreshing if needed.
// Returns the token string, or null when there is no own-token path available
// (caller then falls back to the Keychain). Throws notAuthenticated on a dead
// refresh token (invalid_grant) — re-login is genuinely required.
async function resolveOwnToken(opts) {
  const rec = readOwnToken(opts);
  if (!rec) return null;
  if (!tokenIsExpired(rec)) return rec.accessToken;
  if (!rec.refreshToken) {
    failNotAuthenticated('your stored token expired and there is no refresh token');
  }
  try {
    const fresh = await refreshToken(rec);
    writeOwnToken(fresh, opts);
    return fresh.accessToken;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      failNotAuthenticated('your stored login expired (refresh rejected: invalid_grant)');
    }
    throw e;
  }
}

function failNotAuthenticated(why) {
  fail(
    `not authenticated — run \`claude-design login\`${why ? `\n  (${why})` : ''}`,
    EXIT.notAuthenticated,
  );
}

// ---------------------------------------------------------------------------
// Auth — read the claude.ai OAuth access token. NEVER print the token value.
// ---------------------------------------------------------------------------
// Read Claude Code's stored OAuth blob (Keychain first, then file). Returns the
// parsed blob or null — non-fatal, because this is now a FALLBACK behind the
// CLI's own token store. A malformed file is still surfaced loudly.
function readKeychainBlob() {
  // Test seam: CLAUDE_DESIGN_NO_KEYCHAIN=1 disables the fallback so a test can
  // exercise the "own token only" path on a machine that happens to have a real
  // `Claude Code-credentials` Keychain entry. Production never sets it.
  if (process.env.CLAUDE_DESIGN_NO_KEYCHAIN === '1') return null;
  // macOS Keychain first.
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const blob = JSON.parse(raw);
    if (blob && typeof blob === 'object') return blob;
  } catch {
    // fall through to file
  }
  // Cross-platform fallback file.
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credPath)) {
    try {
      return JSON.parse(readFileSync(credPath, 'utf8'));
    } catch (e) {
      fail(`credentials file ${credPath} is not valid JSON: ${e.message}`);
    }
  }
  return null;
}

// Returns a non-expired Keychain token string, or null if unavailable/expired.
function keychainTokenOrNull() {
  const blob = readKeychainBlob();
  if (!blob) return null;
  const oauth = blob.claudeAiOauth || blob;
  const token = oauth && oauth.accessToken;
  if (!token) return null;
  if (oauth.expiresAt) {
    const exp = Number(oauth.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) return null; // expired
  }
  return token;
}

// Auth precedence:
//   (1) the CLI's OWN stored token (refresh if expired)
//   (2) the existing macOS Keychain "Claude Code-credentials" fallback
//   (3) the "not authenticated — run `claude-design login`" error.
async function resolveToken(opts) {
  const own = await resolveOwnToken(opts); // may fail-not-authenticated on invalid_grant
  if (own) return own;
  const kc = keychainTokenOrNull();
  if (kc) return kc;
  failNotAuthenticated('no stored token and no usable Claude Code credentials');
}

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------
async function rpc(token, body, sessionId, extraHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`network error talking to design endpoint: ${e.message}`);
  }

  const sid = res.headers.get('mcp-session-id');
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();

  let data;
  if (ct.includes('text/event-stream')) {
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((d) => {
        try {
          return JSON.parse(d);
        } catch {
          return d;
        }
      });
    data = events.length === 1 ? events[0] : events;
  } else {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, ct, sid, data, raw: text };
}

// A live MCP session: handshake once, then call tools.
class Session {
  constructor(token, sid) {
    this.token = token;
    this.sid = sid;
    this.id = 100;
    this.hdr = { 'MCP-Protocol-Version': PROTOCOL_VERSION };
  }

  static async open() {
    const token = await resolveToken();
    const init = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT,
      },
    });
    if (init.status === 401 || init.status === 403) {
      fail(
        `authentication rejected by the design endpoint (HTTP ${init.status}).\n` +
          '  Your token may be invalid or lack design access.\n' +
          '  Re-authenticate: run `claude` then `/design-login`.',
      );
    }
    if (init.status >= 400 || !init.data || init.data.error) {
      contractDrift(
        `initialize failed (HTTP ${init.status}): ${JSON.stringify(
          init.data && init.data.error ? init.data.error : init.raw.slice(0, 300),
        )}`,
      );
    }
    // The endpoint may be stateless: a missing Mcp-Session-Id is fine — we
    // proceed without one. When the server DOES return a sid we keep using and
    // forwarding it (rpc() only sets the header when a sid is present), so this
    // stays backward-compatible with the older stateful contract.
    const session = new Session(token, init.sid);
    await rpc(
      token,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      init.sid,
      session.hdr,
    );
    return session;
  }

  async verifyTools(required) {
    const tl = await rpc(
      this.token,
      { jsonrpc: '2.0', id: this.id++, method: 'tools/list', params: {} },
      this.sid,
      this.hdr,
    );
    const tools = tl.data && tl.data.result && tl.data.result.tools;
    if (!Array.isArray(tools)) {
      contractDrift(`tools/list returned no tool array: ${tl.raw.slice(0, 300)}`);
    }
    const names = new Set(tools.map((t) => t.name));
    const missing = required.filter((n) => !names.has(n));
    if (missing.length) {
      contractDrift(`required tool(s) missing from tools/list: ${missing.join(', ')}`);
    }
  }

  // call() fails loudly on a tool error by default. Pass { allowError: true }
  // to instead return { isError: true, message } so the caller can handle a
  // per-item error (e.g. read_file refusing a binary file) without aborting a
  // whole mirror.
  async call(name, args, { allowError = false } = {}) {
    const r = await rpc(
      this.token,
      {
        jsonrpc: '2.0',
        id: this.id++,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      this.sid,
      this.hdr,
    );
    if (r.status === 401 || r.status === 403) {
      fail(`authentication rejected calling ${name} (HTTP ${r.status}). Re-run /design-login.`);
    }
    if (!r.data || typeof r.data !== 'object') {
      contractDrift(`tools/call ${name} returned non-object: ${r.raw.slice(0, 300)}`);
    }
    if (r.data.error) {
      // JSON-RPC error from the server — surface it loudly.
      const err = r.data.error;
      if (allowError) return { isError: true, message: err.message || JSON.stringify(err) };
      fail(`server error from ${name}: ${err.message || JSON.stringify(err)} (code ${err.code})`);
    }
    const result = r.data.result;
    if (!result) {
      contractDrift(`tools/call ${name} had no result field: ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    if (result.isError) {
      const txt = extractText(result);
      if (allowError) return { isError: true, message: txt };
      fail(`tool ${name} reported an error: ${txt}`);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// MCP content-block parsing
// ---------------------------------------------------------------------------
function extractText(result) {
  const blocks = result && result.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// Many of these tools return their payload as JSON inside a text content block.
// Parse it; fail loud if it isn't the expected shape.
function resultJson(result, toolName) {
  // Prefer structuredContent if present (newer MCP), else parse text block.
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const txt = extractText(result);
  if (!txt) {
    contractDrift(`${toolName} returned no text content to parse`);
  }
  try {
    return JSON.parse(txt);
  } catch {
    contractDrift(`${toolName} text content was not JSON: ${txt.slice(0, 200)}`);
  }
}

// Like resultJson but non-fatal: returns the parsed object, or null when the
// result carries no JSON payload (used for tool results whose body is optional,
// e.g. write_files, which may answer with a plain confirmation OR a structured
// { status:"conflict", … } / { etags } object).
function tryResultJson(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const txt = extractText(result);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// Decode a read_file result into raw bytes (Buffer).
// read_file wraps content; text is HTML-entity-escaped, blobs are base64.
function decodeReadFile(result, path) {
  // Look at content blocks directly: a "resource"/"blob" block carries base64,
  // a "text" block carries entity-escaped text.
  const blocks = (result && result.content) || [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    // Embedded resource blob (binary).
    if (b.type === 'resource' && b.resource) {
      if (typeof b.resource.blob === 'string') {
        return Buffer.from(b.resource.blob, 'base64');
      }
      if (typeof b.resource.text === 'string') {
        return Buffer.from(unescapeEntities(b.resource.text), 'utf8');
      }
    }
    if (b.type === 'blob' && typeof b.blob === 'string') {
      return Buffer.from(b.blob, 'base64');
    }
  }
  // Otherwise treat as wrapped text. The server entity-escapes & < > and wraps
  // the body. Recover the body and unescape.
  const txt = extractText(result);
  if (!txt) {
    contractDrift(`read_file for ${path} produced neither blob nor text content`);
  }
  const body = unwrapBody(txt);
  return Buffer.from(unescapeEntities(body), 'utf8');
}

// read_file wraps the body in an <untrusted-project-content path="...">…</…>
// tag and appends a trailing security note AFTER the closing tag. Recover only
// the body between the wrapper's open and close tags. We strip exactly one
// leading newline after the open tag and one trailing newline before the close
// tag (the wrapper's own framing), preserving the original bytes in between.
function unwrapBody(txt) {
  const openRe = /^<untrusted-project-content(?:\s[^>]*)?>\n?/;
  const open = txt.match(openRe);
  if (open) {
    const closeIdx = txt.lastIndexOf('</untrusted-project-content>');
    if (closeIdx === -1) {
      contractDrift('read_file wrapper had an opening tag but no closing tag');
    }
    let body = txt.slice(open[0].length, closeIdx);
    // The server frames the body with a trailing newline before the close tag.
    if (body.endsWith('\n')) body = body.slice(0, -1);
    return body;
  }
  // Generic fallback: a single tag-delimited block that IS the whole string.
  const m = txt.match(/^<([a-zA-Z0-9_-]+)(?:\s[^>]*)?>([\s\S]*)<\/\1>\s*$/);
  if (m) return m[2];
  return txt;
}

function unescapeEntities(s) {
  // Only the three the server escapes, in safe order.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Extract the `etag="…"` attribute from a read_file wrapper's opening tag. The
// etag is captured here (not from list_files) so it matches the bytes we
// actually persist — the read_file response carries content+etag atomically,
// while a list_files etag could go stale between listing and reading. Returns
// the etag string, or null when the response carries no etag (contract drift on
// that one file → caller omits it from .etags and falls back to last-write-wins).
function extractEtag(result) {
  // Prefer a blob resource's etag if the server ever surfaces one structurally.
  const blocks = (result && result.content) || [];
  const txt = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const m = txt.match(/^<untrusted-project-content(?=\s)[^>]*\setag="([^"]*)"/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// .etags base-index sidecar (CLI-local metadata; never synced)
// ---------------------------------------------------------------------------
function etagsPath(dir) {
  return join(dir, ETAGS_FILE);
}

// Read the base index, or null when absent (absent => opt-out: push falls back
// to last-write-wins, the backwards-compatible default).
function readEtagsIndex(dir) {
  const p = etagsPath(dir);
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function writeEtagsIndex(dir, map) {
  // Deterministic key order so the sidecar diffs cleanly across runs.
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  writeFileSync(etagsPath(dir), `${JSON.stringify(sorted, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// File listing — recursive descent over list_files
// ---------------------------------------------------------------------------
// Returns an array of file path strings (project-relative, posix-style).
async function listAllFiles(session, projectId) {
  const { files } = await listAllFilesWithEtags(session, projectId);
  return files;
}

// As listAllFiles, but also returns { etagByPath } harvested from the listing
// entries (when the server surfaces a per-entry etag). Used by push's
// delete-drift guard: delete_files has no if_match, so the only way to refuse a
// delete of a file edited upstream since pull is to compare the listing's
// current etag against the .etags base value.
async function listAllFilesWithEtags(session, projectId) {
  const files = [];
  const etagByPath = {};
  async function descend(dir) {
    const result = await session.call('list_files', { project_id: projectId, path: dir });
    const entries = parseListing(result, dir);
    for (const entry of entries) {
      if (entry.isDir) {
        await descend(entry.path);
      } else {
        files.push(entry.path);
        if (entry.etag != null) etagByPath[entry.path] = entry.etag;
      }
    }
  }
  await descend('');
  return { files, etagByPath };
}

// Normalize a list_files result into [{path, isDir}].
function parseListing(result, dir) {
  const data = resultJson(result, 'list_files');
  // Accept a few plausible shapes; pick the array of entries.
  let arr =
    (Array.isArray(data) && data) ||
    data.files ||
    data.entries ||
    data.items ||
    data.children;
  if (!Array.isArray(arr)) {
    contractDrift(`list_files result had no recognizable entry array (keys: ${Object.keys(data)})`);
  }
  return arr.map((e) => {
    if (typeof e === 'string') {
      // Bare string path; infer dir by trailing slash.
      const isDir = e.endsWith('/');
      return { path: joinPosix(dir, stripSlash(e)), isDir, etag: null };
    }
    const name = e.path || e.name;
    if (typeof name !== 'string') {
      contractDrift(`list_files entry had no path/name: ${JSON.stringify(e).slice(0, 120)}`);
    }
    const type = e.type || e.kind;
    const isDir =
      e.is_dir === true ||
      e.isDir === true ||
      type === 'dir' ||
      type === 'directory' ||
      type === 'folder' ||
      (typeof name === 'string' && name.endsWith('/') && e.is_dir !== false);
    // If the entry path already looks absolute-relative (contains the dir),
    // honor it; otherwise join with dir.
    const full = name.includes('/') && (dir === '' || name.startsWith(dir))
      ? stripSlash(name)
      : joinPosix(dir, stripSlash(name));
    const etag = typeof e.etag === 'string' ? e.etag : null;
    return { path: full, isDir, etag };
  });
}

function stripSlash(p) {
  return p.replace(/\/+$/, '');
}
function joinPosix(dir, name) {
  if (!dir) return name;
  return posix.join(dir, name);
}

function shouldSkip(path) {
  // The .etags base-index is CLI-local metadata — never mirror it in either
  // direction (mirrored alongside the suffix-based tool artifacts).
  if (path === ETAGS_FILE) return true;
  return SKIP_SUFFIXES.some((s) => path.endsWith(s));
}

// ---------------------------------------------------------------------------
// Local filesystem walk
// ---------------------------------------------------------------------------
function walkLocal(root) {
  const out = [];
  if (!existsSync(root)) return out;
  (function rec(dir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (name === '.git' || name === 'node_modules') continue;
        rec(abs);
      } else if (st.isFile()) {
        const rel = relative(root, abs).split(sep).join('/');
        out.push(rel);
      }
    }
  })(root);
  return out;
}

function isProtectedLocal(relPath) {
  const base = relPath.split('/').pop();
  return PROTECTED_BASENAMES.includes(base);
}

// The design endpoint can only round-trip text. read_file refuses to return
// binary files at all ("…is a binary file (stored base64); read_file only
// returns text content"), and write_files rejects unrecognized binary content
// types (e.g. application/octet-stream). A file round-trips iff its bytes are
// valid UTF-8 — that is exactly what the server stores and re-serves as text.
// Anything else is NOT mirrorable through this endpoint, so we exclude it from
// pushes and report it on pulls rather than pretend.
function isRoundTrippableText(buf) {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

// Does a read_file error message indicate the file is binary (and so cannot be
// returned by this endpoint at all)? Matched loosely so a minor wording change
// upstream still triggers the graceful-skip path rather than a hard crash.
function isBinaryReadError(message) {
  return typeof message === 'string' && /binary file/i.test(message);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdList() {
  const session = await Session.open();
  await session.verifyTools(['list_projects']);
  const result = await session.call('list_projects', {});
  const data = resultJson(result, 'list_projects');
  let projects =
    (Array.isArray(data) && data) || data.projects || data.items || data.results;
  if (!Array.isArray(projects)) {
    contractDrift(`list_projects had no recognizable project array (keys: ${Object.keys(data)})`);
  }
  if (projects.length === 0) {
    console.log('(no projects)');
    return;
  }
  for (const p of projects) {
    const id = p.project_id || p.id || p.uuid;
    const name = p.name || p.title || '(unnamed)';
    console.log(`${id}\t${name}`);
  }
}

async function cmdPull(projectId, dir) {
  if (!projectId || !dir) fail('usage: claude-design pull <project_id> <dir>');
  const session = await Session.open();
  await session.verifyTools(['list_files', 'read_file']);

  const remotePaths = (await listAllFiles(session, projectId)).filter((p) => !shouldSkip(p));
  const oversize = [];
  const binary = [];
  // Base index built from the read_file responses (etag sourced atomically with
  // the bytes we write — see extractEtag). Only files actually written get an
  // entry; binary/oversize/etag-less files are correctly omitted.
  const etagIndex = {};
  let pulled = 0;

  for (const path of remotePaths) {
    const result = await session.call(
      'read_file',
      { project_id: projectId, path },
      { allowError: true },
    );
    if (result.isError) {
      // The endpoint refuses to return binary files; that is a permanent
      // limitation, not corruption. Skip-and-report rather than aborting the
      // whole pull (real projects contain images/fonts alongside text).
      if (isBinaryReadError(result.message)) {
        binary.push(path);
        continue;
      }
      fail(`read_file failed for ${path}: ${result.message}`);
    }
    // Detect cap: a 256 KiB file may be truncated. We can't always know the true
    // size, but the server caps at 256 KiB; if we receive exactly the cap of
    // decoded bytes we warn. Better: check a reported size if present.
    const bytes = decodeReadFile(result, path);
    if (bytes.length >= READ_CAP) {
      oversize.push({ path, size: bytes.length });
      // Do NOT write a possibly-truncated file silently.
      continue;
    }
    const dest = join(dir, ...path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    // Record this file's etag (sourced from THIS read_file response) so a later
    // push can guard it with if_match. Omit on contract drift (no etag present).
    const etag = extractEtag(result);
    if (etag != null) etagIndex[path] = etag;
    pulled++;
  }

  // Mirror: delete local files no longer upstream (except protected sidecars
  // and the two skipped tool files).
  const remoteSet = new Set(remotePaths);
  const localPaths = walkLocal(dir);
  let deleted = 0;
  for (const rel of localPaths) {
    if (remoteSet.has(rel)) continue;
    if (shouldSkip(rel)) continue;
    if (isProtectedLocal(rel)) continue;
    rmSync(join(dir, ...rel.split('/')));
    deleted++;
  }
  pruneEmptyDirs(dir);

  // Persist the base index AFTER writes+deletes settle. Its presence is what
  // opts a directory into conflict-safe push; absence keeps last-write-wins.
  writeEtagsIndex(dir, etagIndex);

  console.log(`pulled ${pulled} file(s) into ${dir}`);
  if (deleted) console.log(`deleted ${deleted} local file(s) no longer upstream`);
  if (binary.length) {
    console.error(
      `\nNOTE: ${binary.length} binary file(s) could not be pulled — the design ` +
        'endpoint only returns text content via read_file. They remain in the ' +
        'project but were not mirrored locally:',
    );
    for (const p of binary) console.error(`  ${p}`);
  }
  if (oversize.length) {
    console.error('\nFAIL: the following file(s) hit the 256 KiB read cap and were NOT written');
    console.error('(read_file cannot return them faithfully — they may be truncated):');
    for (const o of oversize) console.error(`  ${o.path} (>= ${o.size} bytes)`);
    process.exit(2);
  }
}

function pruneEmptyDirs(root) {
  if (!existsSync(root)) return;
  (function rec(dir) {
    let names = readdirSync(dir);
    for (const name of names) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) rec(abs);
    }
    names = readdirSync(dir);
    if (names.length === 0 && dir !== root) {
      try {
        rmSync(dir, { recursive: false });
      } catch {
        /* ignore */
      }
    }
  })(root);
}

async function cmdPush(projectId, dir, { force = false } = {}) {
  if (!projectId || !dir) fail('usage: claude-design push <project_id> <dir> [--force]');
  if (!existsSync(dir)) fail(`local dir does not exist: ${dir}`);
  const session = await Session.open();
  await session.verifyTools(['list_files', 'read_file', 'finalize_plan', 'write_files', 'delete_files']);

  // The base index opts a directory into conflict-safe push. Absent (or --force)
  // => last-write-wins, the backwards-compatible default (no if_match sent, no
  // delete-drift guard). guard === true means: enforce conflict detection.
  const baseEtags = readEtagsIndex(dir);
  const guard = !force && baseEtags != null;

  const { files: allRemote, etagByPath: remoteEtags } = await listAllFilesWithEtags(session, projectId);
  const remotePaths = allRemote.filter((p) => !shouldSkip(p));
  const remoteSet = new Set(remotePaths);

  const localPaths = walkLocal(dir).filter((p) => !shouldSkip(p) && !isProtectedLocal(p));
  const localSet = new Set(localPaths);

  // Determine writes: added or changed.
  const writes = []; // {path, data(base64)}
  const tooLarge = [];
  const binary = []; // local files that cannot round-trip through this endpoint
  for (const path of localPaths) {
    const abs = join(dir, ...path.split('/'));
    const bytes = readFileSync(abs);
    if (!isRoundTrippableText(bytes)) {
      // Non-UTF-8 bytes are not round-trippable: write_files may reject the
      // content type outright, and read_file can never return them for
      // verification. Exclude from the mirror and report — pushing them anyway
      // would create an unverifiable, divergent state (and one rejected file
      // aborts the whole atomic write batch).
      binary.push(path);
      continue;
    }
    if (bytes.length >= READ_CAP) {
      // Inline write goes through the same 256 KiB ceiling as read; flag it.
      tooLarge.push({ path, size: bytes.length });
    }
    let changed = true;
    if (remoteSet.has(path)) {
      // Compare against remote bytes.
      const result = await session.call('read_file', { project_id: projectId, path });
      const remoteBytes = decodeReadFile(result, path);
      changed = !remoteBytes.equals(bytes);
    }
    if (changed) writes.push({ path, data: bytes.toString('base64') });
  }

  if (tooLarge.length) {
    console.error('\nFAIL: the following local file(s) exceed the 256 KiB inline-write cap:');
    for (const t of tooLarge) console.error(`  ${t.path} (${t.size} bytes)`);
    console.error('Inline write_files cannot carry them. (Use server-side copy_files for large');
    console.error('design-system assets — not implemented in this CLI v1.)');
    process.exit(2);
  }

  // Determine deletes: removed locally. Additive safety: never delete skipped
  // tool files (already excluded from remotePaths).
  const deletes = remotePaths.filter((p) => !localSet.has(p));

  // Delete-drift guard (only when guarding): delete_files has no if_match and
  // finalize_plan.base_etags is writes-only, so the server cannot refuse a stale
  // delete. Compare each delete target's CURRENT remote etag (from the listing)
  // against the .etags base value; a difference means the file was edited
  // upstream since our pull, so deleting it would silently destroy that edit.
  if (guard) {
    const driftedDeletes = deletes.filter((p) => {
      const base = baseEtags[p];
      const current = remoteEtags[p];
      // Only enforce when we have both a base and a current etag to compare.
      // (A missing base means we never recorded it — fall back to allowing.)
      return base != null && current != null && base !== current;
    });
    if (driftedDeletes.length) {
      console.error(
        '\nCONFLICT: the following file(s) changed upstream since your last pull and ' +
          'were about to be DELETED (refusing — your delete would discard a remote edit):',
      );
      for (const p of driftedDeletes) console.error(`  ${p}`);
      console.error(
        '\nRe-pull and reapply, or use --force to overwrite (last-write-wins).',
      );
      process.exit(EXIT.conflict);
    }
  }

  const reportBinary = () => {
    if (!binary.length) return;
    console.error(
      `\nNOTE: ${binary.length} non-text file(s) were SKIPPED — the design endpoint ` +
        'cannot round-trip binary content (write may reject the type, and read_file ' +
        'never returns it). They were not pushed:',
    );
    for (const p of binary) console.error(`  ${p}`);
  };

  if (writes.length === 0 && deletes.length === 0) {
    if (binary.length) {
      console.log('nothing to push — remote already matches local (text files)');
      reportBinary();
      process.exit(2);
    }
    console.log('nothing to push — remote already matches local');
    return;
  }

  const plan = await session.call('finalize_plan', {
    project_id: projectId,
    writes: writes.map((w) => w.path),
    deletes,
  });
  const planData = resultJson(plan, 'finalize_plan');
  const planToken = planData.plan_token || planData.planToken || planData.token;
  if (!planToken) {
    contractDrift(`finalize_plan returned no plan_token (keys: ${Object.keys(planData)})`);
  }

  // writtenEtags collects the NEW etag of every written file (returned by
  // write_files). Refreshing .etags from these — not just from pull — is what
  // lets two consecutive pushes (no intervening pull) both succeed: the CLI
  // itself advances the remote, so the next push's if_match must reflect that.
  let writtenEtags = {};
  if (writes.length) {
    // allowError:true is REQUIRED: the LIVE endpoint returns an if_match
    // mismatch as a tool result with isError:true (the conflict JSON in its text
    // block). Without allowError, Session.call would hard-fail (generic exit 1)
    // and skip the conflict path below. write_files is atomic so nothing is
    // written either way, but the exit code/message must be the conflict ones.
    const result = await session.call(
      'write_files',
      {
        project_id: projectId,
        plan_token: planToken,
        // if_match is sourced from the .etags BASE (pull/last-push time), never a
        // push-time read_file — only the base value guards the real remote-vs-local
        // window. The "0" sentinel means "expected absent" → create-only.
        files: writes.map((w) => ({
          path: w.path,
          data: w.data,
          encoding: 'base64',
          ...(guard ? { if_match: baseEtags[w.path] ?? '0' } : {}),
        })),
      },
      { allowError: true },
    );
    if (result.isError) {
      // The error body is the tool's text block. A conflict is the expected,
      // recoverable error → run the conflict path. Anything else is a genuine
      // failure → fail loudly (today's behavior for real write_files errors).
      let parsed = null;
      try {
        parsed = JSON.parse(result.message);
      } catch {
        /* non-JSON error → treated as a genuine failure below */
      }
      if (parsed && parsed.status === 'conflict') {
        // write_files is atomic: on conflict NOTHING was written. Abort the whole
        // push (don't proceed to deletes) and report the drifted paths.
        const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
        const paths = conflicts.map((c) => (c && c.path) || c).filter(Boolean);
        console.error(
          '\nCONFLICT: the following file(s) changed upstream since your last pull — ' +
            'nothing was written (push is atomic):',
        );
        for (const p of (paths.length ? paths : ['(unspecified)'])) console.error(`  ${p}`);
        console.error(
          '\nRemote changed since your last pull — re-pull and reapply, or use --force ' +
            'to overwrite (last-write-wins).',
        );
        process.exit(EXIT.conflict);
      }
      fail(`write_files failed: ${result.message}`);
    }
    // Success: parse defensively — an etags map is JSON, but a bare success
    // confirmation might not be, so a non-JSON success must NOT become contract
    // drift (this result was previously ignored entirely).
    const wdata = tryResultJson(result);
    if (wdata && wdata.etags && typeof wdata.etags === 'object') {
      writtenEtags = wdata.etags;
    }
  }

  // Two-phase mutation, two-phase .etags refresh. The push applies write_files
  // then delete_files under one plan_token, and writes-first is the safe order
  // (a delete failure cannot lose data the writes already landed). The matching
  // hazard is the INDEX: if delete_files dies after the writes landed but before
  // we record their new etags, a future edit+push of a written file would send a
  // STALE base if_match → a spurious conflict. So persist the written files'
  // fresh etags NOW (before delete_files), then persist again after the deletes
  // complete to drop the deleted paths. Net: the writes' etags survive a partial
  // failure and a re-run converges. Only when baseEtags != null — push never
  // CREATES .etags; it's born on pull.
  if (baseEtags != null && writes.length) {
    writeEtagsIndex(dir, { ...baseEtags, ...writtenEtags });
  }

  if (deletes.length) {
    // delete_files is the second mutation. A transport/server failure here is a
    // PARTIAL application, not a total failure: the writes already landed and
    // (above) their etags are recorded. Surface that precisely instead of the
    // bare network/server error fail() would emit — a re-run completes the
    // remaining deletes (the converged writes drop out of the recomputed set).
    // allowError keeps this narrow: only this one call is softened.
    const del = await session.call(
      'delete_files',
      { project_id: projectId, plan_token: planToken, paths: deletes },
      { allowError: true },
    );
    if (del && del.isError) {
      console.error(
        `\npush partially applied: ${writes.length} write(s) succeeded; ` +
          `delete(s) failed (${del.message}) — re-run \`claude-design push\` to ` +
          'complete the remaining delete(s).',
      );
      process.exit(EXIT.error);
    }
  }

  // Both phases applied. Refresh the index again, now dropping the deleted paths
  // so the next push carries fresh if_match values and no longer references them.
  if (baseEtags != null) {
    const next = { ...baseEtags, ...writtenEtags };
    for (const d of deletes) delete next[d];
    writeEtagsIndex(dir, next);
  }

  console.log(`pushed: ${writes.length} write(s), ${deletes.length} delete(s) to ${projectId}`);
  if (writes.length) for (const w of writes) console.log(`  + ${w.path}`);
  if (deletes.length) for (const d of deletes) console.log(`  - ${d}`);
  if (binary.length) {
    reportBinary();
    process.exit(2);
  }
}

async function cmdCreate(name) {
  if (!name) fail('usage: claude-design create <name>');
  const session = await Session.open();
  await session.verifyTools(['create_project']);
  const result = await session.call('create_project', { name });
  const data = resultJson(result, 'create_project');
  const projectId = data.project_id || data.id;
  const url = data.url;
  if (!projectId) {
    contractDrift(`create_project returned no project_id (keys: ${Object.keys(data)})`);
  }
  console.log(JSON.stringify({ project_id: projectId, url: url || null }, null, 2));
}

// ---------------------------------------------------------------------------
// OAuth: login / monitor-auth / whoami / logout commands
//
// Stateless split (no daemon, no orphan process):
//   `login`        — emit the authorize URL + a login id, write a pending record,
//                    and RETURN. It starts NO listener and spawns NO process.
//   `monitor-auth` — read the pending record, bind the loopback port, run the
//                    /callback server, and BLOCK in the foreground until the
//                    callback completes (exchange→store→exit 0), times out, or
//                    errors (exit 20). This is the only place the listener lives,
//                    inside the command the agent is actively awaiting.
//
// This is the idiomatic `gh auth login` foreground-loopback pattern, split in
// two so the URL surfaces first. The agent should run `monitor-auth` IMMEDIATELY
// after surfacing the URL so the port is listening before the user clicks.
// ---------------------------------------------------------------------------
async function cmdLogin(args) {
  const manual = args.includes('--manual');
  const codeIdx = args.indexOf('--code');
  const code = codeIdx !== -1 ? args[codeIdx + 1] : null;

  // login --code <code>: complete a previously-started --manual flow.
  if (code) {
    const pending = readPending();
    if (!pending || !pending.manual) {
      fail(
        'no manual login is in progress — run `claude-design login --manual` first',
        EXIT.usage,
      );
    }
    try {
      const rec = await exchangeCode({
        code,
        redirectUri: pending.redirect_uri,
        verifier: pending.verifier,
        state: pending.state,
      });
      writeOwnToken(rec);
      clearPending();
      console.log('auth: authenticated — token stored');
      return;
    } catch (e) {
      fail(`login failed: ${e.message}`, EXIT.authFailed);
    }
  }

  const { verifier, challenge, state } = makePkce();
  const id = makeLoginId();

  if (manual) {
    const redirectUri = AUTH.manualRedirectUri;
    const url = buildAuthorizeUrl({ challenge, state, redirectUri });
    writePending({
      id, verifier, state, redirect_uri: redirectUri, manual: true, createdAt: Date.now(),
    });
    console.log(url);
    console.log(
      'Open this URL to approve, copy the code shown, then run: ' +
        '`claude-design login --code <code>`',
    );
    return;
  }

  // Loopback flow: discover a free OS-assigned port (bind :0, read it, release
  // it) so the redirect_uri is known before we print the URL. `monitor-auth`
  // re-binds this exact port when the agent runs it.
  const port = await findFreeLoopbackPort();
  const redirectUri = `http://localhost:${port}/callback`;
  const url = buildAuthorizeUrl({ challenge, state, redirectUri });

  writePending({
    id, verifier, state, port, redirect_uri: redirectUri, manual: false, createdAt: Date.now(),
  });

  console.log(url);
  console.log(
    `open this URL to approve, then run \`claude-design monitor-auth ${id}\` ` +
      '(it blocks until login completes).',
  );
}

// Find a free loopback port by briefly binding :0, then releasing it. There is a
// tiny race between release and `monitor-auth` re-binding it; if another process
// grabs it in between, monitor-auth fails loudly (exit 20) telling the agent to
// re-run login.
function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Resolve the monitor-auth timeout (ms): --timeout <sec> > env > default.
function monitorTimeoutMs(args) {
  const i = args.indexOf('--timeout');
  if (i !== -1 && args[i + 1] != null) {
    const sec = Number(args[i + 1]);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  const envSec = Number(process.env.CLAUDE_DESIGN_MONITOR_TIMEOUT);
  if (Number.isFinite(envSec) && envSec > 0) return envSec * 1000;
  return MONITOR_TIMEOUT_MS;
}

// monitor-auth <id> (BLOCKING): bind the pending record's loopback port, run the
// /callback server, and block until callback success (exit 0), timeout (exit
// 20), or error/bad-state (exit 20). Plain foreground command — no detach.
async function cmdMonitorAuth(args) {
  const timeoutMs = monitorTimeoutMs(args);
  // The id is the first positional arg: skip any flag and the value following
  // --timeout (when present).
  const tIdx = args.indexOf('--timeout');
  const timeoutValIdx = tIdx === -1 ? -1 : tIdx + 1;
  const id = args.find((a, i) => !a.startsWith('--') && i !== timeoutValIdx);
  if (!id) {
    fail('usage: claude-design monitor-auth <id> [--timeout <sec>]', EXIT.usage);
  }
  const pending = readPending();
  if (!pending || pending.id !== id) {
    fail(
      `no pending login found for id "${id}" — run \`claude-design login\` first`,
      EXIT.authFailed,
    );
  }
  if (pending.manual) {
    fail(
      'that login is a --manual login — complete it with `claude-design login --code <code>`',
      EXIT.usage,
    );
  }
  const { verifier, state, port, redirect_uri: redirectUri } = pending;
  if (!port || !verifier || !state || !redirectUri) {
    fail('pending login record is incomplete — re-run `claude-design login`', EXIT.authFailed);
  }

  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (verdict) => {
      if (done) return;
      done = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve(verdict);
    };

    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url, redirectUri);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const cbCode = reqUrl.searchParams.get('code');
      const cbState = reqUrl.searchParams.get('state');
      if (!cbCode || cbState !== state) {
        res.writeHead(400).end('invalid callback (state mismatch or missing code)');
        finish({ ok: false, error: 'state mismatch or missing code in callback' });
        return;
      }
      // Send the browser to the friendly success page while we exchange.
      res.writeHead(302, { Location: AUTH.successUrl }).end();
      try {
        const rec = await exchangeCode({ code: cbCode, redirectUri, verifier, state });
        writeOwnToken(rec);
        clearPending();
        finish({ ok: true });
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
    });

    server.on('error', (e) => {
      // Most likely EADDRINUSE: another process took the port after login
      // released it.
      finish({
        ok: false,
        error: `port ${port} unavailable (${e.code || e.message}) — re-run \`claude-design login\``,
      });
    });

    const timer = setTimeout(
      () => finish({ ok: false, error: `login timed out (no callback within ${Math.round(timeoutMs / 1000)}s)` }),
      timeoutMs,
    );
    server.listen(port, '127.0.0.1');
  });

  if (result.ok) {
    console.log('auth: authenticated — token stored');
    process.exit(EXIT.ok);
  }
  fail(`login failed: ${result.error}`, EXIT.authFailed);
}

// whoami: instant, non-blocking — is there a usable stored token? Refresh if
// expired. NEVER prints the token. exit 0 authed / 4 not.
async function cmdWhoami() {
  const rec = readOwnToken();
  if (!rec) {
    // No own token — try the Keychain fallback so whoami reflects what the sync
    // commands would actually use.
    const kc = keychainTokenOrNull();
    if (kc) {
      console.log('authenticated (via Claude Code Keychain fallback)');
      process.exit(EXIT.ok);
    }
    console.log('not authenticated — run `claude-design login`');
    process.exit(EXIT.notAuthenticated);
  }
  if (tokenIsExpired(rec)) {
    if (!rec.refreshToken) {
      console.log('expired — run `claude-design login`');
      process.exit(EXIT.notAuthenticated);
    }
    try {
      const fresh = await refreshToken(rec);
      writeOwnToken(fresh);
    } catch (e) {
      const why = e.code === 'invalid_grant' ? 'refresh rejected' : e.message;
      console.log(`expired (${why}) — run \`claude-design login\``);
      process.exit(EXIT.notAuthenticated);
    }
  }
  const who = describeAccount(rec);
  console.log(`authenticated${who ? ` as ${who}` : ''}`);
  process.exit(EXIT.ok);
}

// Best-effort human label for the stored token, if the record carries one.
// Never returns or exposes the token itself.
function describeAccount(rec) {
  return (rec && (rec.account || rec.organization || rec.org)) || null;
}

function cmdLogout() {
  clearOwnToken();
  clearPending();
  console.log('auth: logged out — stored token and any pending login cleared');
}

// ---------------------------------------------------------------------------
// Serve command
// ---------------------------------------------------------------------------
async function cmdServe(args) {
  // Parse positional + flags.
  // Usage: serve <dir> [--port <n>] [--open] [--no-reload]
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const positional = args.filter((a) => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '--port');

  const portIdx = args.indexOf('--port');
  const portVal = portIdx !== -1 ? Number(args[portIdx + 1]) : 4321;
  const port = Number.isFinite(portVal) && portVal >= 0 ? portVal : 4321;

  const openBrowser = flags.has('--open');
  const reload = !flags.has('--no-reload');

  const dir = positional[0];
  if (!dir) fail('usage: claude-design serve <dir> [--port <n>] [--open] [--no-reload]', EXIT.usage);

  const { existsSync: existsSyncLocal, statSync: statSyncLocal } = await import('node:fs');
  if (!existsSyncLocal(dir)) fail(`directory not found: ${dir}`, EXIT.usage);
  if (!statSyncLocal(dir).isDirectory()) fail(`not a directory: ${dir}`, EXIT.usage);

  let srv;
  try {
    srv = await startServer(dir, { port, reload, open: openBrowser });
  } catch (e) {
    if (e.code === 'EADDRINUSE') fail(`port ${port} is already in use — pick another with --port`, 1);
    throw e;
  }

  printBanner(dir, srv.port, reload);

  // Block until Ctrl-C.
  await new Promise(() => {
    process.on('SIGINT', () => {
      srv.close().then(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      srv.close().then(() => process.exit(0));
    });
  });
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
const USAGE = `claude-design — inference-free design-asset sync (UNOFFICIAL)

Usage:
  claude-design login                         Print an authorize URL + login id, then return (no daemon)
  claude-design monitor-auth <id> [--timeout <sec>]
                                              BLOCK until that login completes (exit 0=ok, 20=failed/timeout)
  claude-design login --manual                Headless/SSH login (prints URL to paste a code)
  claude-design login --code <code>           Complete a --manual login with the pasted code
  claude-design whoami                        Instant auth check (exit 0=authed, 4=not authed)
  claude-design logout                        Clear the CLI's stored token + pending login
  claude-design list                          List your design projects (id + name)
  claude-design pull <project_id> <dir>       Mirror a project DOWN into <dir>
  claude-design push <project_id> <dir> [--force]
                                              Mirror <dir> UP (conflict-safe when a .etags is present; --force = last-write-wins)
  claude-design create <name>                 Create a new project
  claude-design serve <dir> [--port <n>] [--open] [--no-reload]
                                              Serve <dir> over HTTP with live-reload (default port 4321)

Agent login flow:
  1. run \`claude-design login\` -> it prints an authorize URL + a login id and returns.
  2. IMMEDIATELY run \`claude-design monitor-auth <id>\` -> it binds the loopback port
     and BLOCKS (so the port is listening before the user clicks).
  3. open the URL and complete sign-in; monitor-auth exits 0 (done) or 20 (failed/timeout).

Auth precedence: the CLI's own stored token (auto-refreshed) -> the macOS
Keychain "Claude Code-credentials" fallback. Token stored at
~/.config/claude-design/credentials.json (mode 0600). Tokens are never printed.`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'login':
      await cmdLogin(args);
      break;
    case 'monitor-auth':
      await cmdMonitorAuth(args);
      break;
    case 'whoami':
      await cmdWhoami();
      break;
    case 'logout':
      cmdLogout();
      break;
    case 'list':
      await cmdList();
      break;
    case 'pull':
      await cmdPull(args[0], args[1]);
      break;
    case 'push': {
      const positional = args.filter((a) => !a.startsWith('--'));
      await cmdPush(positional[0], positional[1], { force: args.includes('--force') });
      break;
    }
    case 'create':
      await cmdCreate(args[0]);
      break;
    case 'serve':
      await cmdServe(args);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`, EXIT.usage);
  }
}

// Only run the CLI when executed directly — importing this module (e.g. from
// tests) must NOT trigger main().
//
// When installed globally (npx / npm i -g / any bin-symlink), process.argv[1]
// is the symlink path while import.meta.url is the resolved real file URL.
// Resolving the symlink on argv[1] via realpathSync makes the comparison
// reliable regardless of how the binary was invoked.
let isMain = false;
try {
  isMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '')).href;
} catch { /* argv[1] missing or unresolvable → not main */ }
if (isMain) {
  main().catch((e) => {
    fail(`unexpected error: ${e && e.stack ? e.stack : e}`);
  });
}

// Exports for tests (pure/verifiable pieces + storage helpers).
export {
  AUTH,
  EXIT,
  base64url,
  makePkce,
  makeLoginId,
  buildAuthorizeUrl,
  readOwnToken,
  writeOwnToken,
  clearOwnToken,
  readPending,
  writePending,
  clearPending,
  tokenIsExpired,
  exchangeCode,
  refreshToken,
};
