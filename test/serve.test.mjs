// Tests for `claude-design serve <dir> [--port <n>] [--open] [--no-reload]`
//
// Drives the serve module directly (imported), not as a subprocess, so tests
// are fast and don't need process lifecycle management. The serve module exports
// a `startServer(dir, opts)` function that returns { server, port, close }.
//
// Assertions:
//   - Each known extension returns 200 + correct Content-Type + body.
//   - Served HTML contains the injected `/__livereload` EventSource snippet.
//   - Non-HTML files (jsx, json, etc.) do NOT contain the injected snippet.
//   - GET /__livereload returns text/event-stream.
//   - A `../` traversal request is rejected (403 or 404).
//   - Modifying a watched file pushes a `data: reload` SSE event to a connected client.
//   - Directory request → index.html when present.
//   - Teardown: server is closed after each test.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Import the serve module (to be created).
import { startServer } from '../bin/serve.mjs';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let tmpDir;

function makeFixtureDir() {
  tmpDir = mkdtempSync(join(tmpdir(), 'cd-serve-'));

  // Top-level HTML
  writeFileSync(join(tmpDir, 'index.html'), '<html><body><h1>hello</h1></body></html>');
  writeFileSync(join(tmpDir, 'TinyTill Screens.html'), '<!DOCTYPE html><body>screens</body>');

  // JSX file
  writeFileSync(join(tmpDir, 'App.jsx'), 'function App() { return <div/>; }');

  // JSON
  writeFileSync(join(tmpDir, 'data.json'), '{"key":"value"}');

  // Nested file
  mkdirSync(join(tmpDir, 'screens'));
  writeFileSync(join(tmpDir, 'screens', 'Home.jsx'), '// home screen');

  return tmpDir;
}

after(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Simple HTTP GET returning { status, headers, body }.
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpGet(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

// Read a few bytes from an SSE stream (returns what arrives before timeout).
function readSSEChunk(port, path, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let data = '';
    const req = httpGet(`http://127.0.0.1:${port}${path}`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
    });
    req.on('error', () => resolve(data));
    setTimeout(() => { req.destroy(); resolve(data); }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('serves index.html with text/html content-type and 200', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/index.html');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'), res.headers['content-type']);
    assert.ok(res.body.includes('<h1>hello</h1>'), 'body should contain original HTML');
  } finally {
    await close();
  }
});

test('directory request serves index.html when present', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'));
    assert.ok(res.body.includes('<h1>hello</h1>'), 'directory / should serve index.html');
  } finally {
    await close();
  }
});

test('serves .jsx file with application/javascript content-type', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/App.jsx');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('application/javascript'), res.headers['content-type']);
    assert.ok(res.body.includes('function App'), 'body should be jsx source');
  } finally {
    await close();
  }
});

test('serves .json file with application/json content-type', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/data.json');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('application/json'), res.headers['content-type']);
    assert.ok(res.body.includes('"key"'), 'body should be json');
  } finally {
    await close();
  }
});

test('serves nested file (screens/Home.jsx)', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/screens/Home.jsx');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('home screen'));
  } finally {
    await close();
  }
});

test('HTML response contains the injected /__livereload EventSource snippet', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/index.html');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('/__livereload'), 'HTML should contain /__livereload EventSource');
    assert.ok(res.body.includes('EventSource'), 'HTML should contain EventSource constructor');
    assert.ok(res.body.includes('location.reload'), 'HTML should trigger location.reload on message');
  } finally {
    await close();
  }
});

test('non-HTML files (jsx) do NOT have the livereload snippet injected', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/App.jsx');
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes('/__livereload'), 'non-HTML should NOT have livereload script');
  } finally {
    await close();
  }
});

test('GET /__livereload returns text/event-stream', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    // SSE is a streaming endpoint — it never sends a full response body.
    // We only need to check the response status + Content-Type header, then
    // destroy the socket immediately so the test doesn't hang.
    const res = await new Promise((resolve, reject) => {
      const req = httpGet(`http://127.0.0.1:${port}/__livereload`, (r) => {
        // Headers arrive with the status line; destroy before reading body.
        const result = { status: r.statusCode, headers: r.headers };
        r.destroy();
        resolve(result);
      });
      req.on('error', (e) => {
        // destroy() fires an 'error' on the socket — ignore it if we already resolved.
        if (e.code === 'ECONNRESET' || e.code === 'ERR_HTTP_REQUEST_TIMEOUT') return;
        reject(e);
      });
      req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'), res.headers['content-type']);
  } finally {
    await close();
  }
});

test('path traversal (/../) is rejected with 403 or 404', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/../package.json');
    assert.ok(res.status === 403 || res.status === 404, `expected 403 or 404, got ${res.status}`);
  } finally {
    await close();
  }
});

test('modifying a watched file pushes a reload SSE event to a connected client', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    // Collect SSE data from the client connection.
    let sseData = '';
    let sseResolve;
    const ssePromise = new Promise((resolve) => { sseResolve = resolve; });

    const req = httpGet(`http://127.0.0.1:${port}/__livereload`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        sseData += chunk;
        if (sseData.includes('data: reload')) {
          sseResolve();
        }
      });
    });
    req.on('error', () => {});

    // Small delay to ensure the SSE connection is established, then touch a file.
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(join(dir, 'index.html'), '<!-- touched -->');

    // Wait for the reload event (with a generous timeout for fs.watch latency).
    const raceResult = await Promise.race([
      ssePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no reload event within timeout')), 3000)),
    ]);

    req.destroy();
    assert.ok(sseData.includes('data: reload'), `expected "data: reload" in SSE stream, got: ${JSON.stringify(sseData)}`);
  } finally {
    await close();
  }
});

test('--no-reload: HTML is served without the livereload snippet', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: false });
  try {
    const res = await get(port, '/index.html');
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes('/__livereload'), 'with reload:false, snippet must not be injected');
  } finally {
    await close();
  }
});

test('missing file returns 404', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const res = await get(port, '/nonexistent.html');
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// Regression test: SSE headers must be flushed PROMPTLY on bare connect — within
// ~1 s, without waiting for a file change or the 20 s heartbeat. Without
// res.flushHeaders() / res.write(':ok\n\n') after writeHead, Node holds the
// headers in its buffer until the first body write, so 'response' never fires
// within the 1 s window and this test fails.
test('/__livereload flushes headers promptly on bare connect (no file change, <1s)', async () => {
  const dir = makeFixtureDir();
  const { close, port } = await startServer(dir, { port: 0, reload: true });
  try {
    const result = await new Promise((resolve, reject) => {
      // Reject if no response arrives within 1 s.
      const deadline = setTimeout(
        () => reject(new Error('headers not received within 1000ms — server did not flush on connect')),
        1000,
      );
      const req = httpGet(`http://127.0.0.1:${port}/__livereload`, (res) => {
        clearTimeout(deadline);
        // Grab headers then immediately kill the socket — we don't want to read
        // the endless SSE body.
        const { statusCode, headers } = res;
        req.destroy();
        resolve({ statusCode, contentType: headers['content-type'] });
      });
      req.on('error', (e) => {
        // destroy() triggers ECONNRESET — ignore it if we already resolved.
        if (e.code === 'ECONNRESET' || e.code === 'ERR_HTTP_REQUEST_TIMEOUT') return;
        reject(e);
      });
    });
    assert.equal(result.statusCode, 200, `expected 200, got ${result.statusCode}`);
    assert.ok(
      result.contentType?.includes('text/event-stream'),
      `expected text/event-stream, got ${result.contentType}`,
    );
  } finally {
    await close();
  }
});
