// Integration tests for token exchange + refresh against a LOCAL stub token
// server (no live network). The OAuth token URL is overridden via
// CLAUDE_DESIGN_TOKEN_URL before importing the module.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Spin up a stub token server and point the CLI at it BEFORE importing the module
// (AUTH.tokenUrl is read at module-eval time).
let server;
let calls = [];
let nextResponse = { status: 200, body: {} };

before(async () => {
  await new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
        res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextResponse.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      process.env.CLAUDE_DESIGN_TOKEN_URL = `http://127.0.0.1:${port}/token`;
      resolve();
    });
  });
});

after(() => server && server.close());

test('exchangeCode posts JSON-only and maps response to a stored record', async () => {
  calls = [];
  nextResponse = {
    status: 200,
    body: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'user:design:read user:design:write' },
  };
  const { exchangeCode, AUTH } = await import('../bin/claude-design.mjs');

  const before = Date.now();
  const rec = await exchangeCode({
    code: 'CODE', redirectUri: 'http://localhost:1/callback', verifier: 'VER', state: 'ST',
  });

  // Request shape: Content-Type JSON only (no Authorization), correct grant.
  assert.equal(calls.length, 1);
  const ct = calls[0].headers['content-type'] || '';
  assert.ok(ct.includes('application/json'), `expected json content-type, got ${ct}`);
  assert.equal(calls[0].headers['authorization'], undefined, 'no Authorization header on token call');
  assert.deepEqual(calls[0].body, {
    grant_type: 'authorization_code',
    code: 'CODE',
    redirect_uri: 'http://localhost:1/callback',
    client_id: AUTH.clientId,
    code_verifier: 'VER',
    state: 'ST',
  });

  // Response mapping: expiresAt = now + expires_in*1000 (within a small window).
  assert.equal(rec.accessToken, 'AT1');
  assert.equal(rec.refreshToken, 'RT1');
  assert.ok(rec.expiresAt >= before + 3600_000 - 50 && rec.expiresAt <= Date.now() + 3600_000);
});

test('exchangeCode throws on an error response', async () => {
  nextResponse = { status: 400, body: { error: 'invalid_request', error_description: 'bad code' } };
  const { exchangeCode } = await import('../bin/claude-design.mjs');
  await assert.rejects(
    () => exchangeCode({ code: 'x', redirectUri: 'r', verifier: 'v', state: 's' }),
    /token exchange failed/,
  );
});

test('refreshToken keeps the old refresh_token when the server omits one', async () => {
  nextResponse = { status: 200, body: { access_token: 'AT2', expires_in: 100 } }; // no refresh_token
  const { refreshToken } = await import('../bin/claude-design.mjs');
  const fresh = await refreshToken({ refreshToken: 'OLD_RT', accessToken: 'old', expiresAt: 0 });
  assert.equal(fresh.accessToken, 'AT2');
  assert.equal(fresh.refreshToken, 'OLD_RT', 'old refresh token retained');
});

test('refreshToken throws a tagged invalid_grant error for re-login', async () => {
  nextResponse = { status: 400, body: { error: 'invalid_grant' } };
  const { refreshToken } = await import('../bin/claude-design.mjs');
  await assert.rejects(
    () => refreshToken({ refreshToken: 'DEAD', accessToken: 'x', expiresAt: 0 }),
    (e) => e.code === 'invalid_grant',
  );
});
