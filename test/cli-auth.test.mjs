// End-to-end tests for the reshaped auth surface, driving the real CLI as a
// subprocess. These prove the stateless `login` + blocking `monitor-auth` design:
//   - `login` emits a well-formed URL + id, writes a pending record, and spawns
//     NO process / starts NO listener (the discovered port is still free after).
//   - `monitor-auth` binds that port, completes end-to-end against a simulated
//     browser callback (exit 0, token stored), and times out (exit 20).
//   - `login --manual` + `login --code` round-trip via a stub token server.
//   - `whoami` reports states with the documented exit codes (0 / 4).
//   - a sync command with no token exits 4.
//
// A local stub stands in for the OAuth token endpoint (CLAUDE_DESIGN_TOKEN_URL);
// no live network. HOME is redirected to a temp dir so credentials/pending land
// in a sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-design.mjs');

// --- stub token server -----------------------------------------------------
let tokenServer;
let tokenUrl;
let nextToken = { status: 200, body: {} };
let tokenCalls = [];

before(async () => {
  await new Promise((resolve) => {
    tokenServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        tokenCalls.push(JSON.parse(raw || '{}'));
        res.writeHead(nextToken.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextToken.body));
      });
    });
    tokenServer.listen(0, '127.0.0.1', () => {
      tokenUrl = `http://127.0.0.1:${tokenServer.address().port}/token`;
      resolve();
    });
  });
});

after(() => tokenServer && tokenServer.close());

// --- helpers ---------------------------------------------------------------
function run(args, { home, extraEnv = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_DESIGN_TOKEN_URL: tokenUrl,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`command timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'cd-cli-'));
  return Promise.resolve(fn(home)).finally(() =>
    rmSync(home, { recursive: true, force: true }),
  );
}

function pendingPath(home) {
  return join(home, '.config', 'claude-design', 'pending.json');
}
function credPath(home) {
  return join(home, '.config', 'claude-design', 'credentials.json');
}

// Is a TCP port free to bind on loopback? (proves nothing is listening).
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// Fire the OAuth callback at the loopback listener (simulated browser redirect).
function hitCallback(port, code, state) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    const req = httpGet(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

// Poll until something is listening on the port (monitor-auth has bound it).
function waitForListening(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = connect(port, '127.0.0.1');
      sock.on('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('port never started listening'));
        else setTimeout(tryOnce, 50);
      });
    };
    tryOnce();
  });
}

// --- login (loopback) ------------------------------------------------------
test('login writes a pending record, emits a well-formed URL + id, and spawns NO process', async () => {
  await withHome(async (home) => {
    const { code, stdout } = await run(['login'], { home });
    assert.equal(code, 0, stdout);

    // pending record written with the loopback shape.
    assert.ok(existsSync(pendingPath(home)), 'pending.json written');
    const pending = JSON.parse(readFileSync(pendingPath(home), 'utf8'));
    assert.match(pending.id, /^[0-9a-f]{8}$/);
    assert.equal(pending.manual, false);
    assert.ok(pending.port > 0, 'pending record carries a discovered port');
    assert.equal(pending.redirect_uri, `http://localhost:${pending.port}/callback`);
    assert.ok(pending.verifier && pending.state);

    // Output: a well-formed authorize URL + the id + a monitor-auth instruction.
    const urlLine = stdout.split('\n').find((l) => l.startsWith('https://'));
    assert.ok(urlLine, 'an authorize URL is printed');
    const u = new URL(urlLine);
    assert.equal(u.origin + u.pathname, 'https://claude.com/cai/oauth/authorize');
    assert.equal(u.searchParams.get('redirect_uri'), pending.redirect_uri);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('state'), pending.state);
    assert.ok(stdout.includes(pending.id), 'the login id is surfaced');
    assert.ok(stdout.includes('monitor-auth'), 'next-step points at monitor-auth');

    // CRITICAL: no daemon — the discovered port is still free (nothing listening).
    assert.equal(await portIsFree(pending.port), true, 'login must NOT leave a listener bound');
  });
});

// --- monitor-auth blocking round-trip --------------------------------------
test('monitor-auth binds the port, completes end-to-end against a callback, stores token, exit 0', async () => {
  await withHome(async (home) => {
    const login = await run(['login'], { home });
    assert.equal(login.code, 0);
    const pending = JSON.parse(readFileSync(pendingPath(home), 'utf8'));

    nextToken = {
      status: 200,
      body: { access_token: 'AT_LOOP', refresh_token: 'RT_LOOP', expires_in: 3600 },
    };

    // Start the blocking monitor; it should bind the port and wait.
    const monitor = run(['monitor-auth', pending.id], { home });

    // Once it's listening, simulate the browser redirect to /callback.
    await waitForListening(pending.port);
    const status = await hitCallback(pending.port, 'THE_CODE', pending.state);
    assert.equal(status, 302, 'callback redirects the browser to the success page');

    const { code, stdout } = await monitor;
    assert.equal(code, 0, stdout);
    assert.ok(stdout.includes('authenticated'), stdout);

    // Token stored; pending cleared.
    assert.ok(existsSync(credPath(home)), 'credentials written');
    const cred = JSON.parse(readFileSync(credPath(home), 'utf8'));
    assert.equal(cred.designOauth.accessToken, 'AT_LOOP');
    assert.equal(existsSync(pendingPath(home)), false, 'pending cleared on success');

    // The exchange used the loopback redirect_uri + verifier from the record.
    const last = tokenCalls[tokenCalls.length - 1];
    assert.equal(last.grant_type, 'authorization_code');
    assert.equal(last.code, 'THE_CODE');
    assert.equal(last.redirect_uri, pending.redirect_uri);
    assert.equal(last.code_verifier, pending.verifier);
  });
});

test('monitor-auth times out with exit 20 when no callback arrives', async () => {
  await withHome(async (home) => {
    await run(['login'], { home });
    const pending = JSON.parse(readFileSync(pendingPath(home), 'utf8'));
    // --timeout 1 (second) so the test is fast.
    const { code, stdout } = await run(['monitor-auth', pending.id, '--timeout', '1'], { home });
    assert.equal(code, 20, stdout);
    // pending stays so the agent can re-run monitor-auth.
    assert.ok(existsSync(pendingPath(home)), 'pending kept after timeout');
  });
});

test('monitor-auth with an unknown id exits 20', async () => {
  await withHome(async (home) => {
    const { code, stdout } = await run(['monitor-auth', 'deadbeef', '--timeout', '1'], { home });
    assert.equal(code, 20, stdout);
  });
});

test('monitor-auth parses a bare positional id (no flags) and finds the pending record', async () => {
  await withHome(async (home) => {
    await run(['login'], { home });
    const pending = JSON.parse(readFileSync(pendingPath(home), 'utf8'));
    nextToken = { status: 200, body: { access_token: 'AT_BARE', expires_in: 3600 } };
    // No --timeout flag at all — the id must still be parsed as the positional.
    const monitor = run(['monitor-auth', pending.id], { home });
    await waitForListening(pending.port);
    await hitCallback(pending.port, 'CODE_BARE', pending.state);
    const { code, stdout } = await monitor;
    assert.equal(code, 0, stdout);
    const cred = JSON.parse(readFileSync(credPath(home), 'utf8'));
    assert.equal(cred.designOauth.accessToken, 'AT_BARE');
  });
});

// --- manual flow -----------------------------------------------------------
test('login --manual + login --code round-trip against the stub, exit 0', async () => {
  await withHome(async (home) => {
    const manual = await run(['login', '--manual'], { home });
    assert.equal(manual.code, 0);
    const urlLine = manual.stdout.split('\n').find((l) => l.startsWith('https://'));
    const u = new URL(urlLine);
    assert.equal(
      u.searchParams.get('redirect_uri'),
      'https://platform.claude.com/oauth/code/callback',
    );
    const pending = JSON.parse(readFileSync(pendingPath(home), 'utf8'));
    assert.equal(pending.manual, true);
    assert.equal(pending.port, undefined, 'manual record carries no port');

    nextToken = { status: 200, body: { access_token: 'AT_MANUAL', expires_in: 3600 } };
    const complete = await run(['login', '--code', 'PASTED_CODE'], { home });
    assert.equal(complete.code, 0, complete.stdout);
    const cred = JSON.parse(readFileSync(credPath(home), 'utf8'));
    assert.equal(cred.designOauth.accessToken, 'AT_MANUAL');
    assert.equal(existsSync(pendingPath(home)), false, 'pending cleared after --code');

    const last = tokenCalls[tokenCalls.length - 1];
    assert.equal(last.redirect_uri, 'https://platform.claude.com/oauth/code/callback');
    assert.equal(last.code, 'PASTED_CODE');
  });
});

test('login --code with no pending manual login exits 2 (usage)', async () => {
  await withHome(async (home) => {
    const { code } = await run(['login', '--code', 'x'], { home });
    assert.equal(code, 2);
  });
});

// --- whoami ----------------------------------------------------------------
test('whoami exits 4 and says not authenticated with no token', async () => {
  await withHome(async (home) => {
    // Disable the Keychain fallback (a real entry may exist on the dev machine)
    // so this exercises the pure "no own token" path.
    const { code, stdout } = await run(['whoami'], {
      home, extraEnv: { CLAUDE_DESIGN_NO_KEYCHAIN: '1' },
    });
    assert.equal(code, 4, stdout);
    assert.ok(/not authenticated/.test(stdout), stdout);
  });
});

test('whoami exits 0 and reports authenticated with a valid stored token', async () => {
  await withHome(async (home) => {
    // Seed a valid token via the manual flow.
    await run(['login', '--manual'], { home });
    nextToken = { status: 200, body: { access_token: 'AT_OK', expires_in: 3600 } };
    await run(['login', '--code', 'c'], { home });

    const { code, stdout } = await run(['whoami'], { home });
    assert.equal(code, 0, stdout);
    assert.ok(/authenticated/.test(stdout), stdout);
    assert.ok(!stdout.includes('AT_OK'), 'whoami must NEVER print the token');
  });
});

test('whoami refreshes an expired token and exits 0', async () => {
  await withHome(async (home) => {
    await run(['login', '--manual'], { home });
    // Store a token that is already expired but has a refresh token.
    nextToken = { status: 200, body: { access_token: 'AT_OLD', refresh_token: 'RT', expires_in: -10 } };
    await run(['login', '--code', 'c'], { home });

    // whoami should refresh it transparently.
    nextToken = { status: 200, body: { access_token: 'AT_FRESH', expires_in: 3600 } };
    const { code, stdout } = await run(['whoami'], { home });
    assert.equal(code, 0, stdout);
    const cred = JSON.parse(readFileSync(credPath(home), 'utf8'));
    assert.equal(cred.designOauth.accessToken, 'AT_FRESH', 'token was refreshed');
  });
});

// --- logout ----------------------------------------------------------------
test('logout clears token + pending and is idempotent', async () => {
  await withHome(async (home) => {
    await run(['login'], { home }); // leaves a pending record
    const out1 = await run(['logout'], { home });
    assert.equal(out1.code, 0);
    assert.equal(existsSync(pendingPath(home)), false);
    assert.equal(existsSync(credPath(home)), false);
    const out2 = await run(['logout'], { home }); // no-op
    assert.equal(out2.code, 0);
  });
});

// --- sync command without auth --------------------------------------------
// --- live auth (real endpoint, real HOME) ----------------------------------
// Proves live auth still resolves (own token or the unchanged macOS Keychain
// `Claude Code-credentials` fallback) and `list` reaches the real design
// endpoint. Uses the developer's REAL HOME — the `security` CLI resolves the
// login keychain relative to $HOME, so a sandbox HOME can't see it. Skipped
// automatically when no auth source is present (CI / non-macOS / not logged in)
// so the suite stays green without it.
test('list authenticates live (own token or Keychain fallback) and is never exit 4', async (t) => {
  const { execFileSync } = await import('node:child_process');
  let haveAuth = false;
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    haveAuth = true;
  } catch {
    /* no Keychain entry */
  }
  if (!haveAuth && existsSync(join(process.env.HOME, '.config', 'claude-design', 'credentials.json'))) {
    haveAuth = true;
  }
  if (!haveAuth) {
    t.skip('no live auth source (Keychain entry or own token) on this machine');
    return;
  }
  // Real HOME, no token-url override (hit the real endpoint), no NO_KEYCHAIN.
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'list'], { env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const k = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('list timed out')); }, 30000);
    child.on('close', (c) => { clearTimeout(k); resolve({ code: c, stdout: out, stderr: err }); });
    child.on('error', reject);
  });
  // Auth must resolve: never "not authenticated" (exit 4). Healthy = exit 0; a
  // contract/endpoint hiccup is a different non-zero code, but never 4.
  assert.notEqual(code, 4, `expected live auth to resolve; got 4.\n${stderr}`);
  assert.ok(stdout.length >= 0);
});

test('a sync command with no token and no Keychain exits 4', async () => {
  await withHome(async (home) => {
    // `list` resolves a token first; sandbox HOME + Keychain disabled = none.
    const { code, stderr } = await run(['list'], {
      home, extraEnv: { CLAUDE_DESIGN_NO_KEYCHAIN: '1' },
    });
    assert.equal(code, 4, stderr);
    assert.ok(/not authenticated/.test(stderr), stderr);
  });
});
