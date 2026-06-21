#!/usr/bin/env node
// claude-design — deterministic, inference-free design-asset sync against
// Claude Code's (undocumented) Design MCP endpoint. No LLM, no subagents.
//
// UNOFFICIAL / UNSUPPORTED: this drives an undocumented endpoint. See README.
import { execFileSync, spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
  rmSync, openSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative, sep, posix } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.anthropic.com/v1/design/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const READ_CAP = 256 * 1024; // 256 KiB
const CLIENT = { name: 'claude-design', version: '0.1.0' };

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

// Background listener self-timeout (ms) and a safety skew for expiry checks.
const LISTENER_TIMEOUT_MS = 5 * 60 * 1000; // ~5 min
const EXPIRY_SKEW_MS = 30 * 1000; // refresh slightly before real expiry
const TOKEN_HTTP_TIMEOUT_MS = 30 * 1000;

// Distinct exit codes the polling agent relies on. Keep STABLE.
const EXIT = {
  ok: 0,
  error: 1, // generic failure
  usage: 2, // bad usage (matches existing push/pull cap-fail convention)
  notAuthenticated: 4, // a command needs auth but no valid token is available
  authPending: 10, // auth-check: listener still waiting
  authFailed: 20, // auth-check: failed / timed out / no login in progress
};

// Files that are tool-managed artifacts on the design side: never mirror down,
// never delete up.
const SKIP_SUFFIXES = ['.thumbnail', '.design-canvas.state.json'];
// Local-only sidecars we must never delete during a DOWN mirror.
const PROTECTED_BASENAMES = ['PROVENANCE.md', 'CANONICAL.md'];

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
// OAuth: CLI-owned token + login-status storage
// Layout under ~/.config/claude-design/:
//   credentials.json  -> { designOauth: { accessToken, refreshToken, expiresAt, scopes } }
//   login-status.json -> { status, ... } the detached listener writes; auth-check reads
// ---------------------------------------------------------------------------
function configDir({ home = homedir() } = {}) {
  return join(home, '.config', 'claude-design');
}
function credentialsPath(opts) {
  return join(configDir(opts), 'credentials.json');
}
function statusPath(opts) {
  return join(configDir(opts), 'login-status.json');
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

function writeLoginStatus(rec, opts) {
  const dir = configDir(opts);
  mkdirSync(dir, { recursive: true });
  const path = statusPath(opts);
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(rec, null, 2));
  } finally {
    closeSync(fd);
  }
  return path;
}

function readLoginStatus(opts) {
  const path = statusPath(opts);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function clearLoginStatus(opts) {
  const path = statusPath(opts);
  if (existsSync(path)) rmSync(path, { force: true });
}

function tokenIsExpired(rec) {
  if (!rec || rec.expiresAt == null) return false; // no expiry info -> assume valid
  const exp = Number(rec.expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp <= Date.now() + EXPIRY_SKEW_MS;
}

// Map a stored login-status record to an auth-check {code, line}.
function classifyAuthCheck(status) {
  if (!status || !status.status) {
    return { code: EXIT.authFailed, line: 'auth: no login in progress — run `claude-design login`' };
  }
  switch (status.status) {
    case 'success':
      return { code: EXIT.ok, line: 'auth: authenticated' };
    case 'pending':
      return { code: EXIT.authPending, line: 'auth: pending — open the login URL, then poll again' };
    case 'failed':
    default:
      return {
        code: EXIT.authFailed,
        line: `auth: login failed${status.error ? ` (${status.error})` : ''} — run \`claude-design login\``,
      };
  }
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
    if (!init.sid) {
      contractDrift('initialize returned no Mcp-Session-Id header');
    }
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

// ---------------------------------------------------------------------------
// File listing — recursive descent over list_files
// ---------------------------------------------------------------------------
// Returns an array of file path strings (project-relative, posix-style).
async function listAllFiles(session, projectId) {
  const files = [];
  async function descend(dir) {
    const result = await session.call('list_files', { project_id: projectId, path: dir });
    const entries = parseListing(result, dir);
    for (const entry of entries) {
      if (entry.isDir) {
        await descend(entry.path);
      } else {
        files.push(entry.path);
      }
    }
  }
  await descend('');
  return files;
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
      return { path: joinPosix(dir, stripSlash(e)), isDir };
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
    return { path: full, isDir };
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

async function cmdPush(projectId, dir) {
  if (!projectId || !dir) fail('usage: claude-design push <project_id> <dir>');
  if (!existsSync(dir)) fail(`local dir does not exist: ${dir}`);
  const session = await Session.open();
  await session.verifyTools(['list_files', 'read_file', 'finalize_plan', 'write_files', 'delete_files']);

  const remotePaths = (await listAllFiles(session, projectId)).filter((p) => !shouldSkip(p));
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

  if (writes.length) {
    await session.call('write_files', {
      project_id: projectId,
      plan_token: planToken,
      files: writes.map((w) => ({ path: w.path, data: w.data, encoding: 'base64' })),
    });
  }
  if (deletes.length) {
    await session.call('delete_files', {
      project_id: projectId,
      plan_token: planToken,
      paths: deletes,
    });
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
// OAuth: login / auth-check / logout commands
//
// login is a NON-BLOCKING two-step dance for an orchestrating agent:
//   1. bind a loopback port, persist a "pending" status carrying the PKCE
//      verifier+state+redirect_uri, then spawn a DETACHED child that re-enters
//      this same script as `__listen` to run the callback server.
//   2. print the authorize URL + a one-line instruction and exit 0 immediately.
// The agent opens the URL, then polls `auth-check` until exit 0/20.
// ---------------------------------------------------------------------------
async function cmdLogin(args) {
  const manual = args.includes('--manual');
  const codeIdx = args.indexOf('--code');
  const code = codeIdx !== -1 ? args[codeIdx + 1] : null;

  // login --code <code>: complete a previously-started --manual flow.
  if (code) {
    const pending = readLoginStatus();
    if (!pending || pending.status !== 'pending' || pending.mode !== 'manual') {
      fail(
        'no manual login is in progress — run `claude-design login --manual` first',
        EXIT.usage,
      );
    }
    try {
      const rec = await exchangeCode({
        code,
        redirectUri: pending.redirectUri,
        verifier: pending.verifier,
        state: pending.state,
      });
      writeOwnToken(rec);
      writeLoginStatus({ status: 'success', at: Date.now() });
      console.log('auth: authenticated — token stored');
      return;
    } catch (e) {
      writeLoginStatus({ status: 'failed', error: e.message, at: Date.now() });
      fail(`login failed: ${e.message}`);
    }
  }

  const { verifier, challenge, state } = makePkce();

  if (manual) {
    const redirectUri = AUTH.manualRedirectUri;
    const url = buildAuthorizeUrl({ challenge, state, redirectUri });
    writeLoginStatus({
      status: 'pending', mode: 'manual', verifier, state, redirectUri, at: Date.now(),
    });
    console.log(url);
    console.log(
      'Open this URL, approve, copy the code shown, then run: ' +
        '`claude-design login --code <code>`',
    );
    return;
  }

  // Loopback flow: bind an OS-assigned port FIRST so the redirect_uri is known
  // before we print the URL, then hand the bound port to a detached listener.
  const port = await bindLoopbackPort();
  const redirectUri = `http://localhost:${port}/callback`;
  const url = buildAuthorizeUrl({ challenge, state, redirectUri });

  // Persist pending state the listener + auth-check both read.
  writeLoginStatus({
    status: 'pending', mode: 'loopback', verifier, state, redirectUri, port, at: Date.now(),
  });

  spawnDetachedListener({ verifier, state, redirectUri, port });

  console.log(url);
  console.log(
    'Open this URL in your browser, then poll `claude-design auth-check` ' +
      '(exit 0 = done, 10 = pending, 20 = failed).',
  );
}

// Find a free loopback port by briefly binding :0, then releasing it. There is a
// tiny race between release and the listener re-binding; acceptable for a local
// interactive login (the listener fails loudly into status=failed if it can't).
function bindLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function spawnDetachedListener({ verifier, state, redirectUri, port }) {
  const child = spawn(
    process.execPath,
    [process.argv[1], '__listen', String(port)],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CLAUDE_DESIGN_VERIFIER: verifier,
        CLAUDE_DESIGN_STATE: state,
        CLAUDE_DESIGN_REDIRECT: redirectUri,
      },
    },
  );
  child.unref();
}

// Detached entry point: run the loopback callback server until it gets the
// callback or self-times-out, then write the resulting login-status record and
// exit. Never prints to a console the parent reads (stdio is ignored).
async function cmdListen(portArg) {
  const port = Number(portArg);
  const verifier = process.env.CLAUDE_DESIGN_VERIFIER;
  const state = process.env.CLAUDE_DESIGN_STATE;
  const redirectUri = process.env.CLAUDE_DESIGN_REDIRECT;
  if (!port || !verifier || !state || !redirectUri) {
    writeLoginStatus({ status: 'failed', error: 'listener missing parameters', at: Date.now() });
    process.exit(EXIT.error);
  }

  await new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      writeLoginStatus({ ...status, at: Date.now() });
      try {
        server.close();
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve();
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
        finish({ status: 'failed', error: 'state mismatch or missing code' });
        return;
      }
      // Send the browser to the friendly success page while we exchange.
      res.writeHead(302, { Location: AUTH.successUrl }).end();
      try {
        const rec = await exchangeCode({ code: cbCode, redirectUri, verifier, state });
        writeOwnToken(rec);
        finish({ status: 'success' });
      } catch (e) {
        finish({ status: 'failed', error: e.message });
      }
    });

    server.on('error', (e) => finish({ status: 'failed', error: `listener bind failed: ${e.message}` }));
    const timer = setTimeout(
      () => finish({ status: 'failed', error: 'login timed out (no callback within 5 min)' }),
      LISTENER_TIMEOUT_MS,
    );
    server.listen(port, '127.0.0.1');
  });

  process.exit(EXIT.ok);
}

// auth-check: read the stored status, refresh a valid token if needed, print one
// clear line, and exit with the documented code (0 / 10 / 20).
async function cmdAuthCheck() {
  const status = readLoginStatus();
  const verdict = classifyAuthCheck(status);
  if (verdict.code === EXIT.ok) {
    // Confirm we still have a usable token (refresh transparently if expired).
    const rec = readOwnToken();
    if (!rec) {
      console.log('auth: login reported success but no token is stored — run `claude-design login`');
      process.exit(EXIT.authFailed);
    }
    if (tokenIsExpired(rec)) {
      if (!rec.refreshToken) {
        console.log('auth: token expired and no refresh token — run `claude-design login`');
        process.exit(EXIT.authFailed);
      }
      try {
        const fresh = await refreshToken(rec);
        writeOwnToken(fresh);
      } catch (e) {
        console.log(`auth: token refresh failed (${e.message}) — run \`claude-design login\``);
        process.exit(EXIT.authFailed);
      }
    }
  }
  console.log(verdict.line);
  process.exit(verdict.code);
}

function cmdLogout() {
  clearOwnToken();
  clearLoginStatus();
  console.log('auth: logged out — stored token and any pending login cleared');
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
const USAGE = `claude-design — inference-free design-asset sync (UNOFFICIAL)

Usage:
  claude-design login                         Start OAuth login (non-blocking; prints URL)
  claude-design login --manual                Headless/SSH login (prints URL to paste a code)
  claude-design login --code <code>           Complete a --manual login with the pasted code
  claude-design auth-check                     Poll login status (exit 0=ok, 10=pending, 20=failed)
  claude-design logout                        Clear the CLI's stored token + pending login
  claude-design list                          List your design projects (id + name)
  claude-design pull <project_id> <dir>       Mirror a project DOWN into <dir>
  claude-design push <project_id> <dir>       Mirror <dir> UP to a project
  claude-design create <name>                 Create a new project

Agent login flow:
  1. run \`claude-design login\` -> it prints an authorize URL and returns immediately.
  2. open that URL in a browser and complete sign-in.
  3. poll \`claude-design auth-check\` until it exits 0 (done) or 20 (failed/timeout).

Auth precedence: the CLI's own stored token (auto-refreshed) -> the macOS
Keychain "Claude Code-credentials" fallback. Token stored at
~/.config/claude-design/credentials.json (mode 0600). Tokens are never printed.`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'login':
      await cmdLogin(args);
      break;
    case 'auth-check':
      await cmdAuthCheck();
      break;
    case 'logout':
      cmdLogout();
      break;
    case '__listen': // internal: detached loopback callback server
      await cmdListen(args[0]);
      break;
    case 'list':
      await cmdList();
      break;
    case 'pull':
      await cmdPull(args[0], args[1]);
      break;
    case 'push':
      await cmdPush(args[0], args[1]);
      break;
    case 'create':
      await cmdCreate(args[0]);
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
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
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
  buildAuthorizeUrl,
  readOwnToken,
  writeOwnToken,
  clearOwnToken,
  tokenIsExpired,
  classifyAuthCheck,
  exchangeCode,
  refreshToken,
};
