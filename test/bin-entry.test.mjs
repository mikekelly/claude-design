// Regression test for the symlink bin-entry bug.
//
// When claude-design is installed globally (npx, npm i -g, or any bin-symlink),
// process.argv[1] is the symlink path while import.meta.url is the resolved
// real file URL. Before the fix, the isMain guard compared them directly,
// they never matched, and the CLI silently exited 0 with no output.
//
// This test invokes the CLI *through a symlink* — the way a user does — and
// asserts that main() actually ran (non-empty stdout or a recognised exit code).
//
// To prove RED → GREEN:
//   - With the OLD guard (no realpathSync), the test fails: stdout is empty.
//   - With the FIXED guard (realpathSync on argv[1]), the test passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-design.mjs');

test('CLI runs when invoked via a symlink (installed-bin scenario)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cd-symlink-'));
  try {
    // Create a symlink that mimics what `npm install -g` or `npx` produces:
    //   /opt/homebrew/bin/claude-design -> <realpath>/bin/claude-design.mjs
    const symlinkPath = join(tmp, 'claude-design');
    symlinkSync(BIN, symlinkPath);

    // Invoke through the symlink: argv[1] will be the symlink path,
    // import.meta.url will be the real file URL — the discrepancy that caused
    // the bug. `whoami` is safe: it prints output regardless of auth state.
    const HOME = mkdtempSync(join(tmpdir(), 'cd-home-'));
    try {
      const result = spawnSync(process.execPath, [symlinkPath, 'whoami'], {
        env: { ...process.env, HOME },
        encoding: 'utf8',
        timeout: 15000,
      });

      // If the bug is present: both stdout and stderr are empty and exit is 0
      // (main() never ran). With the fix: whoami prints something (either an
      // authenticated user line or "not authenticated") and exits 0 or 4.
      const combined = (result.stdout || '') + (result.stderr || '');
      assert.ok(
        combined.trim().length > 0,
        `Expected CLI output when invoked via symlink but got nothing.\n` +
        `exit=${result.status} signal=${result.signal}\n` +
        `stdout=${JSON.stringify(result.stdout)}\n` +
        `stderr=${JSON.stringify(result.stderr)}`,
      );

      // Exit code must be 0 (authenticated) or 4 (not authenticated).
      // Any other exit code (e.g. 1) means an unexpected error.
      assert.ok(
        result.status === 0 || result.status === 4,
        `Expected exit 0 or 4 from whoami, got ${result.status}`,
      );
    } finally {
      rmSync(HOME, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
