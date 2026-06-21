// Tests for the standalone OAuth login added to claude-design.
// Pure/verifiable pieces only — no real browser, no network to the live endpoint.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  base64url,
  makePkce,
  makeLoginId,
  buildAuthorizeUrl,
  AUTH,
  readOwnToken,
  writeOwnToken,
  clearOwnToken,
  readPending,
  writePending,
  clearPending,
  tokenIsExpired,
} from '../bin/claude-design.mjs';

// --- PKCE / state ----------------------------------------------------------
test('base64url strips padding and is url-safe', () => {
  // bytes 0xfb 0xff produce + and / in standard base64 ("+/8=")
  const out = base64url(Buffer.from([0xfb, 0xff]));
  assert.ok(!/[+/=]/.test(out), `expected url-safe, got ${out}`);
});

test('makePkce produces verifier, S256 challenge, and state', () => {
  const { verifier, challenge, state } = makePkce();
  assert.ok(verifier.length >= 43, 'verifier should be >=43 chars (32 bytes b64url)');
  assert.ok(challenge.length >= 43, 'challenge should be a sha256 b64url');
  assert.ok(state.length >= 43, 'state should be 32 bytes b64url');
  assert.notEqual(verifier, challenge);
});

test('makePkce challenge is the real S256 of the verifier', async () => {
  const { createHash } = await import('node:crypto');
  const { verifier, challenge } = makePkce();
  const expected = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
});

test('makeLoginId is 8 lowercase hex chars and varies', () => {
  const a = makeLoginId();
  const b = makeLoginId();
  assert.match(a, /^[0-9a-f]{8}$/, `expected 8 hex chars, got ${a}`);
  assert.notEqual(a, b);
});

// --- authorize URL ---------------------------------------------------------
test('buildAuthorizeUrl is well-formed with all required params', () => {
  const { verifier, challenge, state } = makePkce();
  const redirectUri = 'http://localhost:54321/callback';
  const url = new URL(buildAuthorizeUrl({ challenge, state, redirectUri }));

  assert.equal(url.origin + url.pathname, AUTH.authorizeUrl);
  assert.equal(url.searchParams.get('code'), 'true');
  assert.equal(url.searchParams.get('client_id'), AUTH.clientId);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('scope'), AUTH.scopes);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), state);
});

test('AUTH constants match the verified OAuth spec', () => {
  assert.equal(AUTH.clientId, '59637612-477b-4836-a601-b0589eda7704');
  assert.equal(AUTH.authorizeUrl, 'https://claude.com/cai/oauth/authorize');
  assert.equal(AUTH.tokenUrl, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(AUTH.scopes, 'user:design:read user:design:write');
});

// --- token storage ---------------------------------------------------------
function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cd-auth-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeOwnToken / readOwnToken round-trip and file is mode 0600', () => {
  withTempHome((home) => {
    const rec = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: 123, scopes: AUTH.scopes,
    };
    const path = writeOwnToken(rec, { home });
    assert.ok(existsSync(path));
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600 got ${mode.toString(8)}`);
    const back = readOwnToken({ home });
    assert.deepEqual(back, rec);
    // Stored shape is nested under designOauth and never bare.
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(onDisk.designOauth, 'token stored under designOauth key');
  });
});

test('readOwnToken returns null when no credential file exists', () => {
  withTempHome((home) => {
    assert.equal(readOwnToken({ home }), null);
  });
});

test('clearOwnToken removes the credential file (idempotent)', () => {
  withTempHome((home) => {
    writeOwnToken({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, scopes: '' }, { home });
    clearOwnToken({ home });
    assert.equal(readOwnToken({ home }), null);
    // second call is a no-op, must not throw
    clearOwnToken({ home });
  });
});

// --- expiry / refresh decision --------------------------------------------
test('tokenIsExpired is true for a past expiresAt and false for future', () => {
  assert.equal(tokenIsExpired({ expiresAt: Date.now() - 1000 }), true);
  assert.equal(tokenIsExpired({ expiresAt: Date.now() + 60_000 }), false);
});

test('tokenIsExpired treats a near-expiry token (within skew) as expired', () => {
  // 10s in the future should be considered expired due to the safety skew.
  assert.equal(tokenIsExpired({ expiresAt: Date.now() + 10_000 }), true);
});

// --- pending-login record storage ------------------------------------------
test('writePending / readPending round-trip and file is mode 0600', () => {
  withTempHome((home) => {
    const rec = {
      id: 'abcd1234',
      verifier: 'VER',
      state: 'ST',
      port: 54321,
      redirect_uri: 'http://localhost:54321/callback',
      manual: false,
      createdAt: 1,
    };
    const path = writePending(rec, { home });
    assert.ok(existsSync(path));
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600 got ${mode.toString(8)}`);
    assert.deepEqual(readPending({ home }), rec);
  });
});

test('readPending returns null when no pending file exists', () => {
  withTempHome((home) => {
    assert.equal(readPending({ home }), null);
  });
});

test('clearPending removes the pending file (idempotent)', () => {
  withTempHome((home) => {
    writePending({ id: 'x', manual: true }, { home });
    clearPending({ home });
    assert.equal(readPending({ home }), null);
    clearPending({ home }); // no-op, must not throw
  });
});
