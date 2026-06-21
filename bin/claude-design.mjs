#!/usr/bin/env node
// claude-design — deterministic, inference-free design-asset sync against
// Claude Code's (undocumented) Design MCP endpoint. No LLM, no subagents.
//
// UNOFFICIAL / UNSUPPORTED: this drives an undocumented endpoint. See README.
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative, sep, posix } from 'node:path';

const ENDPOINT = 'https://api.anthropic.com/v1/design/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const READ_CAP = 256 * 1024; // 256 KiB
const CLIENT = { name: 'claude-design', version: '0.1.0' };

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
// Auth — read the claude.ai OAuth access token. NEVER print the token value.
// ---------------------------------------------------------------------------
function readCredentialBlob() {
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
  fail(
    'no claude.ai credentials found (Keychain "Claude Code-credentials" and ' +
      `${credPath} both unavailable).\n  Run \`claude\` then \`/design-login\` to authenticate.`,
  );
}

function getToken() {
  const blob = readCredentialBlob();
  const oauth = blob.claudeAiOauth || blob;
  const token = oauth && oauth.accessToken;
  if (!token) {
    fail(
      'credentials found but no accessToken inside (expected claudeAiOauth.accessToken).\n' +
        '  Run `claude` then `/design-login` to (re)authenticate.',
    );
  }
  if (oauth.expiresAt) {
    const exp = Number(oauth.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      fail(
        'your claude.ai OAuth token has EXPIRED.\n' +
          '  Re-authenticate by running `claude` and then `/design-login`.\n' +
          '  (Automatic token refresh is not implemented in v1 — see README limitations.)',
      );
    }
  }
  return token;
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
    const token = getToken();
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
// CLI dispatch
// ---------------------------------------------------------------------------
const USAGE = `claude-design — inference-free design-asset sync (UNOFFICIAL)

Usage:
  claude-design list                          List your design projects (id + name)
  claude-design pull <project_id> <dir>       Mirror a project DOWN into <dir>
  claude-design push <project_id> <dir>       Mirror <dir> UP to a project
  claude-design create <name>                 Create a new project

Auth: reads your claude.ai OAuth token from the macOS Keychain
("Claude Code-credentials") or ~/.claude/.credentials.json. Authenticate once
by running \`claude\` then \`/design-login\`.`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
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
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => {
  fail(`unexpected error: ${e && e.stack ? e.stack : e}`);
});
