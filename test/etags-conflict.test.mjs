// End-to-end tests for the `.etags` base-index sidecar and conflict-safe push.
//
// These drive the REAL CLI as a subprocess against a LOCAL stub MCP endpoint
// that models a remote project store with per-file etags. The stub supports the
// full push/pull surface: list_files, read_file (etag in the wrapper attr),
// finalize_plan, write_files (honoring per-file if_match + emitting a
// status:"conflict" result on mismatch), and delete_files.
//
// The conflict-response shape is modeled to match the LIVE endpoint: write_files
// answers an if_match mismatch with a tool result carrying isError:true whose
// single text block is the conflict JSON — { status:"conflict",
// conflicts:[{path, etag, current_content|content_omitted}], message }. The CLI
// must read this via { allowError:true } and branch on status==="conflict".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-design.mjs');
const ETAGS_FILE = '.etags';

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

// --- stub MCP endpoint modeling a remote project store ----------------------
//
// `store` is a map path -> { content (string), etag (string) }. etags are
// monotonically bumped on every write so callers can detect drift.
//
// `opts.onWriteFiles(files, store)` optional hook: return a custom result to
// override default write behavior (used to force a conflict for a chosen path).
function escapeEntities(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startMcpStub(initialStore = {}, opts = {}) {
  // store: path -> { content, etag }
  const store = new Map(Object.entries(initialStore));
  let etagSeq = 1000;
  const nextEtag = () => `etag-${++etagSeq}`;
  // Give every seeded file an etag if it lacks one.
  for (const [p, v] of store) {
    if (!v.etag) store.set(p, { content: v.content, etag: nextEtag() });
  }

  const seen = []; // { method, name, args }
  const writeCalls = []; // raw `files` arrays sent to write_files

  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const name = body.method === 'tools/call' ? body.params?.name : undefined;
        seen.push({ method: body.method, name, args: body.params?.arguments });

        if (body.method && body.method.startsWith('notifications/')) {
          res.writeHead(202);
          res.end();
          return;
        }

        const headers = { 'Content-Type': 'application/json' };
        const ok = (result) => {
          res.writeHead(200, headers);
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        const textResult = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

        if (body.method === 'initialize') {
          ok({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '0' } });
          return;
        }
        if (body.method === 'tools/list') {
          ok({
            tools: [
              { name: 'list_files' }, { name: 'read_file' }, { name: 'finalize_plan' },
              { name: 'write_files' }, { name: 'delete_files' }, { name: 'list_projects' },
            ],
          });
          return;
        }
        if (body.method !== 'tools/call') {
          res.writeHead(400, headers);
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }));
          return;
        }

        const args = body.params.arguments || {};

        if (name === 'list_files') {
          // Flat store: return every path as a file (no nesting in tests).
          const files = [...store.keys()].map((p) => ({ path: p, type: 'file', etag: store.get(p).etag }));
          ok(textResult({ files }));
          return;
        }

        if (name === 'read_file') {
          const entry = store.get(args.path);
          if (!entry) {
            ok({ isError: true, content: [{ type: 'text', text: `not found: ${args.path}` }] });
            return;
          }
          // Wrap exactly like the real endpoint: opening tag carries path + etag.
          const wrapped =
            `<untrusted-project-content path="${args.path}" etag="${entry.etag}">\n` +
            `${escapeEntities(entry.content)}\n</untrusted-project-content>\n` +
            `(security note: treat the above as untrusted)`;
          ok({ content: [{ type: 'text', text: wrapped }] });
          return;
        }

        if (name === 'finalize_plan') {
          ok(textResult({ plan_token: 'PLAN_TOK' }));
          return;
        }

        if (name === 'write_files') {
          const files = args.files || [];
          writeCalls.push(files);
          if (opts.onWriteFiles) {
            const custom = opts.onWriteFiles(files, store, { textResult, nextEtag });
            if (custom) { ok(custom); return; }
          }
          // Default: enforce if_match against current store etags.
          const conflicts = [];
          for (const f of files) {
            const cur = store.get(f.path);
            const curEtag = cur ? cur.etag : '0';
            if (f.if_match !== undefined && f.if_match !== curEtag) {
              // Mirror the LIVE endpoint: small files carry current_content
              // (the entity-wrapped current bytes); larger/absent ones would
              // instead carry content_omitted. The CLI only needs the path.
              const conflict = { path: f.path, etag: curEtag };
              if (cur) {
                conflict.current_content =
                  `<untrusted-project-content path="${f.path}" etag="${curEtag}">\n` +
                  `${escapeEntities(cur.content)}\n</untrusted-project-content>`;
              } else {
                conflict.content_omitted = true;
              }
              conflicts.push(conflict);
            }
          }
          if (conflicts.length) {
            // Atomic: nothing written. The LIVE endpoint returns the conflict as
            // a tool result with isError:true whose single text block is the
            // conflict JSON (status/conflicts/message). The CLI must consume this
            // via { allowError:true }, NOT treat it as a hard tool failure.
            ok({
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    conflicts,
                    message:
                      'write_files: refused — the user (or another writer) changed one or more ' +
                      'of these files since your if_match etag. Nothing was written. Re-base on ' +
                      'current_content and retry.',
                    status: 'conflict',
                  }),
                },
              ],
            });
            return;
          }
          // Apply writes, bump etags.
          const etags = {};
          for (const f of files) {
            const content = Buffer.from(f.data, f.encoding || 'base64').toString('utf8');
            const e = nextEtag();
            store.set(f.path, { content, etag: e });
            etags[f.path] = e;
          }
          ok(textResult({ written: files.map((f) => f.path), preview_urls: {}, etags }));
          return;
        }

        if (name === 'delete_files') {
          // opts.onDeleteFiles(paths, store) optional hook: return a JSON-RPC
          // error object to simulate a transport/server failure on delete (used
          // to model a partial push where write_files landed but delete_files
          // dies). Returning anything else / undefined falls through to the
          // default success behavior.
          if (opts.onDeleteFiles) {
            const custom = opts.onDeleteFiles(args.paths || [], store);
            if (custom && custom.error) {
              res.writeHead(200, headers);
              res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: custom.error }));
              return;
            }
          }
          for (const p of args.paths || []) store.delete(p);
          ok(textResult({ deleted: args.paths || [] }));
          return;
        }

        res.writeHead(400, headers);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unknown tool ${name}` } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}/mcp`,
        store, seen, writeCalls,
        close: () => srv.close(),
      });
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
        CLAUDE_DESIGN_NO_KEYCHAIN: '1',
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

async function seedAuth(home) {
  const manual = await run(['login', '--manual'], { home });
  assert.equal(manual.code, 0, manual.stderr);
  const complete = await run(['login', '--code', 'CODE'], { home });
  assert.equal(complete.code, 0, complete.stderr);
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'cd-etags-'));
  try {
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'cd-proj-'));
}

function readEtags(dir) {
  const p = join(dir, '.etags');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Scenario 1: pull writes a correct .etags base index, sourced from read_file.
// ---------------------------------------------------------------------------
test('pull writes .etags with the etag from each read_file response', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({
      'a.txt': { content: 'alpha' },
      'b.txt': { content: 'beta' },
    });
    const dir = makeDir();
    try {
      await seedAuth(home);
      const { code, stderr } = await run(['pull', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(code, 0, stderr);

      const etags = readEtags(dir);
      assert.ok(etags, '.etags must exist after pull');
      // The recorded etag for each path must equal the store etag (the value
      // carried in that file's read_file wrapper).
      assert.equal(etags['a.txt'], stub.store.get('a.txt').etag);
      assert.equal(etags['b.txt'], stub.store.get('b.txt').etag);
      // The .etags sidecar itself is never an entry.
      assert.ok(!('.etags' in etags), '.etags should not index itself');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 1b: the .etags sidecar is never pushed up nor deleted by a pull.
// ---------------------------------------------------------------------------
test('.etags is never uploaded on push and never deleted by a pull', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      // Pull creates .etags.
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);
      assert.ok(readEtags(dir), '.etags written by pull');

      // A subsequent push (no local changes) must not send .etags to the server
      // and must not target it in any write/delete.
      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(push.code, 0, push.stderr);
      const wroteEtags = stub.writeCalls.some((files) => files.some((f) => f.path === ETAGS_FILE));
      assert.ok(!wroteEtags, '.etags must never be uploaded');
      assert.ok(!stub.store.has(ETAGS_FILE), '.etags must never exist remotely');

      // A subsequent pull must not delete the local .etags sidecar.
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);
      assert.ok(existsSync(join(dir, ETAGS_FILE)), '.etags survives a re-pull');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: push with unchanged remote — writes carry the pulled if_match and
// .etags is refreshed to the NEW etags returned by write_files.
// ---------------------------------------------------------------------------
test('push sends if_match from .etags and refreshes .etags from write_files', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);
      const pulledEtag = readEtags(dir)['a.txt'];

      // Locally edit the file so push has a write to do.
      writeFileSync(join(dir, 'a.txt'), 'alpha-edited');
      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(push.code, 0, push.stderr);

      // The write_files call must have carried if_match = the pulled etag.
      const files = stub.writeCalls.at(-1);
      const wa = files.find((f) => f.path === 'a.txt');
      assert.equal(wa.if_match, pulledEtag, 'if_match must equal the pulled base etag');

      // .etags refreshed to the new remote etag (what write_files returned).
      const newEtag = stub.store.get('a.txt').etag;
      assert.notEqual(newEtag, pulledEtag, 'remote etag should have advanced');
      assert.equal(readEtags(dir)['a.txt'], newEtag, '.etags must be refreshed post-push');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: a remote edit after pull makes if_match mismatch → write_files
// returns status:"conflict" → nothing written, CLI exits 5, path named.
// ---------------------------------------------------------------------------
test('push aborts with exit 5 and names the path on a write conflict', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);

      // Simulate a web-UI edit AFTER our pull: remote bytes + etag both change.
      stub.store.set('a.txt', { content: 'alpha-from-web', etag: 'etag-WEB' });
      const remoteEtagBefore = stub.store.get('a.txt').etag;

      // Edit locally too, then push — if_match carries the stale pulled etag.
      writeFileSync(join(dir, 'a.txt'), 'alpha-from-cli');
      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });

      assert.equal(push.code, 5, `expected exit 5, got ${push.code}\n${push.stderr}`);
      assert.ok(push.stderr.includes('a.txt'), `conflicting path named: ${push.stderr}`);
      // Nothing was written: the remote etag/content is untouched.
      assert.equal(stub.store.get('a.txt').etag, remoteEtagBefore, 'remote must be untouched');
      assert.equal(stub.store.get('a.txt').content, 'alpha-from-web');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: a new local file (not in .etags) is pushed with if_match:"0"
// (create-only). The stub accepts it when absent; if it already exists remotely
// the "0" sentinel mismatches the current etag → conflict → exit 5.
// ---------------------------------------------------------------------------
test('new local file pushes with if_match:"0" (create-only) and conflicts if it exists', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);

      // Add a brand-new local file absent from both remote and .etags.
      writeFileSync(join(dir, 'new.txt'), 'fresh');
      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(push.code, 0, push.stderr);
      const sent = stub.writeCalls.at(-1).find((f) => f.path === 'new.txt');
      assert.equal(sent.if_match, '0', 'new file must use the "0" create-only sentinel');
      assert.equal(stub.store.get('new.txt').content, 'fresh');

      // Now a DIFFERENT local dir (also conflict-guarded but with new.txt absent
      // from its .etags) tries to create new.txt — which now exists remotely.
      const dir2 = makeDir();
      try {
        // Pull into dir2 to get a .etags, but it won't include the file we then add.
        assert.equal((await run(['pull', 'p1', dir2], { home, mcpUrl: stub.url })).code, 0);
        // Remove new.txt from dir2's .etags base so the push treats it as a create.
        const e2 = JSON.parse(readFileSync(join(dir2, ETAGS_FILE), 'utf8'));
        delete e2['new.txt'];
        writeFileSync(join(dir2, ETAGS_FILE), JSON.stringify(e2));
        // Local copy differs so a write is queued.
        writeFileSync(join(dir2, 'new.txt'), 'collision');
        const push2 = await run(['push', 'p1', dir2], { home, mcpUrl: stub.url });
        assert.equal(push2.code, 5, `expected conflict exit 5, got ${push2.code}\n${push2.stderr}`);
        assert.ok(push2.stderr.includes('new.txt'), push2.stderr);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: two consecutive pushes (no intervening pull) both succeed —
// proves .etags is refreshed from write_files on push, not only on pull.
// ---------------------------------------------------------------------------
test('two consecutive pushes without a re-pull both succeed', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);

      writeFileSync(join(dir, 'a.txt'), 'edit-1');
      const p1 = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(p1.code, 0, p1.stderr);

      // No re-pull. The remote etag advanced; only a refreshed .etags carries it.
      writeFileSync(join(dir, 'a.txt'), 'edit-2');
      const p2 = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(p2.code, 0, `second push must succeed (refreshed if_match): ${p2.stderr}`);
      assert.equal(stub.store.get('a.txt').content, 'edit-2');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: delete-drift. A delete target whose remote etag advanced since
// pull is refused (exit 5, named); --force lets the delete proceed.
// ---------------------------------------------------------------------------
test('delete-drift is refused with exit 5; --force lets the delete through', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({
      'keep.txt': { content: 'keep' },
      'gone.txt': { content: 'doomed' },
    });
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);

      // Delete gone.txt locally → push would delete it remotely.
      rmSync(join(dir, 'gone.txt'));
      // But the web UI edited gone.txt after our pull (etag advanced).
      stub.store.set('gone.txt', { content: 'doomed-but-edited', etag: 'etag-WEB2' });

      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(push.code, 5, `delete-drift must abort: ${push.stderr}`);
      assert.ok(push.stderr.includes('gone.txt'), push.stderr);
      assert.ok(stub.store.has('gone.txt'), 'remote file must survive the refused delete');

      // --force bypasses the guard and performs the delete.
      const forced = await run(['push', '--force', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(forced.code, 0, forced.stderr);
      assert.ok(!stub.store.has('gone.txt'), '--force should delete the drifted file');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: backwards-compat. With NO .etags present, push behaves exactly as
// before — the stub never receives an if_match on any write.
// ---------------------------------------------------------------------------
test('without a .etags present, push sends no if_match (backwards-compat)', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      // Populate the dir WITHOUT pulling (so no .etags is born).
      writeFileSync(join(dir, 'a.txt'), 'alpha-changed');
      writeFileSync(join(dir, 'b.txt'), 'brand-new');
      assert.ok(!existsSync(join(dir, ETAGS_FILE)), 'no .etags present');

      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(push.code, 0, push.stderr);

      const allWrites = stub.writeCalls.flat();
      assert.ok(allWrites.length > 0, 'there were writes');
      assert.ok(
        allWrites.every((f) => f.if_match === undefined),
        `no write should carry if_match: ${JSON.stringify(allWrites)}`,
      );
      // And push must NOT create a .etags out of thin air.
      assert.ok(!existsSync(join(dir, ETAGS_FILE)), 'push must not birth a .etags');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: PARTIAL APPLICATION. write_files succeeds but delete_files then
// fails (transport/server error). The push must:
//   (a) exit non-zero with a partial-application message naming writes-ok /
//       deletes-failed and telling the user to re-run;
//   (b) refresh .etags with the WRITTEN files' new etags despite the delete
//       failure (so the landed writes are recorded);
//   (c) on a re-run (delete now succeeds) complete the pending delete, exit 0;
//   (d) after the partial failure, editing a written file and pushing must NOT
//       produce a false conflict — the refreshed etag is used as if_match.
// ---------------------------------------------------------------------------
test('partial push (write ok, delete fails) refreshes .etags for writes and re-run converges', async () => {
  await withHome(async (home) => {
    let failDeletes = true; // flipped to false to model the recovery re-run
    const stub = await startMcpStub(
      {
        'keep.txt': { content: 'keep' },
        'gone.txt': { content: 'doomed' },
      },
      {
        onDeleteFiles: () =>
          failDeletes ? { error: { code: -32000, message: 'simulated transport failure' } } : null,
      },
    );
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);
      const baseKeepEtag = readEtags(dir)['keep.txt'];

      // Edit keep.txt (a write) AND delete gone.txt locally → push does both.
      writeFileSync(join(dir, 'keep.txt'), 'keep-edited');
      rmSync(join(dir, 'gone.txt'));

      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      // (a) non-zero exit + a clear partial-application message.
      assert.notEqual(push.code, 0, `partial push must exit non-zero: ${push.stdout}`);
      assert.equal(push.code, 1, `partial push uses EXIT.error (1): ${push.stderr}`);
      assert.match(push.stderr, /partially applied/i, push.stderr);
      assert.match(push.stderr, /write/i, push.stderr);
      assert.match(push.stderr, /delete/i, push.stderr);
      assert.match(push.stderr, /re-run/i, push.stderr);

      // The write actually landed remotely (writes-first ordering).
      assert.equal(stub.store.get('keep.txt').content, 'keep-edited');
      // The delete did NOT happen — gone.txt still present remotely.
      assert.ok(stub.store.has('gone.txt'), 'failed delete must leave the remote file');

      // (b) .etags refreshed with the written file's NEW etag despite the failure.
      const remoteKeepEtag = stub.store.get('keep.txt').etag;
      assert.notEqual(remoteKeepEtag, baseKeepEtag, 'remote etag advanced on write');
      assert.equal(
        readEtags(dir)['keep.txt'],
        remoteKeepEtag,
        '.etags must carry the written etag even though delete_files failed',
      );
      // gone.txt is still in .etags (the delete never completed).
      assert.ok('gone.txt' in readEtags(dir), 'pending delete stays in .etags');

      // (c) Re-run with deletes now succeeding → completes the delete, exit 0.
      // Snapshot the write-call count: a converged push must issue NO write_files
      // (keep.txt is now local==remote), so the count must not grow on the re-run.
      const writeCallsBeforeRerun = stub.writeCalls.length;
      failDeletes = false;
      const push2 = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(push2.code, 0, `re-run must converge: ${push2.stderr}`);
      assert.ok(!stub.store.has('gone.txt'), 're-run completes the pending delete');
      assert.ok(!('gone.txt' in readEtags(dir)), 'deleted path dropped from .etags');
      assert.equal(
        stub.writeCalls.length,
        writeCallsBeforeRerun,
        're-run must not re-write the converged file (no new write_files call)',
      );
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 9b: after a partial push, editing a written file and pushing again
// must NOT raise a false conflict — the refreshed etag is the if_match.
// ---------------------------------------------------------------------------
test('after a partial push, re-editing a written file pushes without a false conflict', async () => {
  await withHome(async (home) => {
    let failDeletes = true;
    const stub = await startMcpStub(
      {
        'keep.txt': { content: 'keep' },
        'gone.txt': { content: 'doomed' },
      },
      {
        onDeleteFiles: () =>
          failDeletes ? { error: { code: -32000, message: 'simulated transport failure' } } : null,
      },
    );
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);

      writeFileSync(join(dir, 'keep.txt'), 'keep-edited');
      rmSync(join(dir, 'gone.txt'));
      const push = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      assert.notEqual(push.code, 0, push.stderr);

      const refreshedEtag = readEtags(dir)['keep.txt'];

      // Now edit the already-written file again. Deletes still fail, but the
      // write must carry the refreshed if_match (no stale base → no false conflict).
      writeFileSync(join(dir, 'keep.txt'), 'keep-edited-again');
      const push2 = await run(['push', 'p1', dir], { home, mcpUrl: stub.url });
      // Still partial (delete fails) but the WRITE half must have succeeded with
      // no conflict — the message is partial-application, not conflict (exit 1 not 5).
      assert.equal(push2.code, 1, `must be partial (1), not a false conflict (5): ${push2.stderr}`);
      assert.doesNotMatch(push2.stderr, /CONFLICT/i, push2.stderr);
      const sent = stub.writeCalls.at(-1).find((f) => f.path === 'keep.txt');
      assert.equal(sent.if_match, refreshedEtag, 'if_match must be the refreshed etag, not the stale base');
      assert.equal(stub.store.get('keep.txt').content, 'keep-edited-again', 'second write landed');
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: --force with a .etags present omits if_match and succeeds even
// where a guarded push would have flagged a conflict.
// ---------------------------------------------------------------------------
test('--force with a .etags present omits if_match and overrides a conflict', async () => {
  await withHome(async (home) => {
    const stub = await startMcpStub({ 'a.txt': { content: 'alpha' } });
    const dir = makeDir();
    try {
      await seedAuth(home);
      assert.equal((await run(['pull', 'p1', dir], { home, mcpUrl: stub.url })).code, 0);

      // Web-UI edit after pull → a guarded push WOULD conflict.
      stub.store.set('a.txt', { content: 'web-edit', etag: 'etag-WEB3' });
      writeFileSync(join(dir, 'a.txt'), 'cli-edit');

      const forced = await run(['push', '--force', 'p1', dir], { home, mcpUrl: stub.url });
      assert.equal(forced.code, 0, `--force must override the conflict: ${forced.stderr}`);
      const sent = stub.writeCalls.at(-1).find((f) => f.path === 'a.txt');
      assert.equal(sent.if_match, undefined, '--force must omit if_match');
      assert.equal(stub.store.get('a.txt').content, 'cli-edit', '--force is last-write-wins');
      // .etags still refreshed from the returned etags.
      assert.equal(readEtags(dir)['a.txt'], stub.store.get('a.txt').etag);
    } finally {
      stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
