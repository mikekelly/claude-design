// Regression tests for the MCP session-id contract, driving the real CLI as a
// subprocess against a LOCAL stub MCP endpoint (no live network).
//
// The design MCP endpoint went STATELESS: `initialize` now returns 200 with a
// valid result but NO `Mcp-Session-Id` response header, and subsequent calls
// carry no session header. The CLI used to hard-fail (contract-drift, exit 3)
// when the session id was missing. These tests prove:
//   - a stateless endpoint (no Mcp-Session-Id) makes `list` succeed (exit 0).
//   - when the endpoint DOES return a session id, it's still forwarded on every
//     subsequent request (backward-compat preserved).
//
// Two local stubs stand in for the OAuth token endpoint
// (CLAUDE_DESIGN_TOKEN_URL) and the design MCP endpoint (CLAUDE_DESIGN_MCP_URL);
// HOME is redirected to a temp dir so credentials land in a sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-design.mjs');

// --- stub token server (mints a valid token via the manual login flow) ------
let tokenServer;
let tokenUrl;

before(async () => {
  await new Promise((resolve) => {
    tokenServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'AT_MCP', expires_in: 3600 }));
      });
    });
    tokenServer.listen(0, '127.0.0.1', () => {
      tokenUrl = `http://127.0.0.1:${tokenServer.address().port}/token`;
      resolve();
    });
  });
});

after(() => tokenServer && tokenServer.close());

// --- stub MCP endpoint ------------------------------------------------------
// `withSid` toggles whether `initialize` returns a Mcp-Session-Id header.
// Records every request's session header so we can assert forwarding.
function startMcpStub({ withSid }) {
  const seen = []; // { method, sessionHeader }
  const tools = [{ name: 'list_projects' }];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ method: body.method, sessionHeader: req.headers['mcp-session-id'] });

        // notifications/* have no id and expect a 202 with no body.
        if (body.method && body.method.startsWith('notifications/')) {
          res.writeHead(202);
          res.end();
          return;
        }

        const headers = { 'Content-Type': 'application/json' };
        let result;
        if (body.method === 'initialize') {
          if (withSid) headers['Mcp-Session-Id'] = 'SID_123';
          result = {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'stub', version: '0.0.0' },
          };
        } else if (body.method === 'tools/list') {
          result = { tools };
        } else if (body.method === 'tools/call' && body.params.name === 'list_projects') {
          result = {
            content: [
              { type: 'text', text: JSON.stringify({ projects: [{ id: 'p1', name: 'Proj One' }] }) },
            ],
          };
        } else {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }));
          return;
        }

        res.writeHead(200, headers);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}/mcp`, seen, close: () => srv.close() });
    });
  });
}

// --- helpers ----------------------------------------------------------------
function run(args, { home, mcpUrl }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_DESIGN_TOKEN_URL: tokenUrl,
        ...(mcpUrl ? { CLAUDE_DESIGN_MCP_URL: mcpUrl } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`command timed out: ${args.join(' ')}`));
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

// Seed a valid stored token in `home` via the manual login flow (stub token
// server). This is the same path cli-auth.test.mjs uses to mint credentials.
async function seedAuth(home) {
  const manual = await run(['login', '--manual'], { home });
  assert.equal(manual.code, 0, manual.stderr);
  const complete = await run(['login', '--code', 'CODE'], { home });
  assert.equal(complete.code, 0, complete.stderr);
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'cd-mcp-'));
  try {
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- the regression --------------------------------------------------------
test('list succeeds against a STATELESS endpoint that returns no Mcp-Session-Id', async () => {
  await withHome(async (home) => {
    await seedAuth(home);
    const stub = await startMcpStub({ withSid: false });
    try {
      const { code, stdout, stderr } = await run(['list'], { home, mcpUrl: stub.url });
      // Used to be contract-drift exit 3; must now succeed.
      assert.equal(code, 0, `expected exit 0, got ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`);
      assert.ok(stdout.includes('p1') && stdout.includes('Proj One'), stdout);

      // No request ever carried a session header (there was none to forward).
      const initialize = stub.seen.find((s) => s.method === 'initialize');
      assert.ok(initialize, 'initialize was called');
      assert.ok(
        stub.seen.every((s) => s.sessionHeader === undefined),
        'no Mcp-Session-Id should be sent when the server provided none',
      );
    } finally {
      stub.close();
    }
  });
});

test('a returned Mcp-Session-Id is forwarded on every subsequent request (backward-compat)', async () => {
  await withHome(async (home) => {
    await seedAuth(home);
    const stub = await startMcpStub({ withSid: true });
    try {
      const { code, stdout, stderr } = await run(['list'], { home, mcpUrl: stub.url });
      assert.equal(code, 0, `expected exit 0, got ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`);

      // Every request AFTER initialize must carry the session id the server gave.
      const after = stub.seen.filter((s) => s.method !== 'initialize');
      assert.ok(after.length > 0, 'there were follow-up requests');
      assert.ok(
        after.every((s) => s.sessionHeader === 'SID_123'),
        `all follow-up requests must forward SID_123: ${JSON.stringify(stub.seen)}`,
      );
    } finally {
      stub.close();
    }
  });
});
