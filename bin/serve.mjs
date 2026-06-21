// serve.mjs — zero-dependency static HTTP server with SSE live-reload.
//
// Exported surface (used by tests and the CLI dispatch in claude-design.mjs):
//   startServer(dir, { port?, reload?, open? })
//     -> Promise<{ server, port, close }>
//
// CLI entry point lives in claude-design.mjs (cmdServe); this module is the
// pure server implementation so it can be imported and tested headlessly.

import { createServer } from 'node:http';
import {
  readFileSync, statSync, readdirSync, watch, existsSync,
} from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// MIME type table (extensions the design project produces)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function mimeFor(filePath) {
  return MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Live-reload SSE client snippet (injected into HTML only)
// ---------------------------------------------------------------------------
const LIVERELOAD_SCRIPT = `<script>
(function(){try{var es=new EventSource('/__livereload');es.onmessage=function(){location.reload()};}catch(e){}}());
</script>`;

function injectReloadSnippet(html) {
  // Inject before </body> if present, else append.
  if (html.includes('</body>')) {
    return html.replace('</body>', LIVERELOAD_SCRIPT + '</body>');
  }
  return html + LIVERELOAD_SCRIPT;
}

// ---------------------------------------------------------------------------
// Path-traversal guard
// ---------------------------------------------------------------------------
function isSafe(root, absPath) {
  // Both root and absPath are already resolved.
  const rel = relative(root, absPath);
  // If relative path starts with '..' the file escapes the root.
  return !rel.startsWith('..') && !rel.startsWith('/');
}

// ---------------------------------------------------------------------------
// Directory listing (minimal, top-level *.html prominent)
// ---------------------------------------------------------------------------
function dirListing(dirPath, urlPath) {
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch {
    return null;
  }
  const htmlFiles = entries.filter((e) => e.toLowerCase().endsWith('.html'));
  const others = entries.filter((e) => !e.toLowerCase().endsWith('.html'));

  const listItems = [
    ...htmlFiles.map((e) => `<li><b><a href="${encodeURIComponent(e)}">${e}</a></b></li>`),
    ...others.map((e) => `<li><a href="${encodeURIComponent(e)}">${e}</a></li>`),
  ];

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>Index of ${urlPath}</title></head><body>`,
    `<h2>Index of ${urlPath}</h2><ul>`,
    ...listItems,
    '</ul></body></html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SSE client registry
// ---------------------------------------------------------------------------
function makeClientSet() {
  const clients = new Set();

  function add(res) {
    clients.add(res);
    res.on('close', () => clients.delete(res));
  }

  function broadcast(event) {
    for (const res of clients) {
      try {
        res.write(`data: ${event}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  }

  return { add, broadcast, size: () => clients.size };
}

// ---------------------------------------------------------------------------
// File watcher with debounce
// ---------------------------------------------------------------------------
function watchDir(dir, onchange, debounceMs = 80) {
  let timer = null;
  let watcher = null;

  function trigger() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onchange();
    }, debounceMs);
  }

  try {
    // recursive:true works on macOS (kqueue) and Windows; Linux requires inotify
    // which does NOT support recursive. We degrade gracefully on unsupported
    // platforms by catching the error — the server still works, just no watch.
    watcher = watch(dir, { recursive: true }, (_event, _filename) => {
      trigger();
    });
    watcher.on('error', () => {
      // Transient FS error — ignore; don't crash the server.
    });
  } catch {
    // Platform doesn't support recursive watch; degrade gracefully.
    watcher = null;
  }

  return {
    close() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    },
  };
}

// ---------------------------------------------------------------------------
// Core: startServer
// ---------------------------------------------------------------------------

/**
 * Start the static server.
 *
 * @param {string} dir  Absolute (or relative) path to the directory to serve.
 * @param {object} opts
 * @param {number}  [opts.port=4321]   Port to bind. 0 = OS-assigned.
 * @param {boolean} [opts.reload=true] Inject SSE live-reload snippet into HTML.
 * @param {boolean} [opts.open=false]  Open the first HTML in a browser on start.
 * @returns {Promise<{ server, port, close }>}
 */
export function startServer(dir, opts = {}) {
  const root = resolve(dir);
  const reload = opts.reload !== false; // default true
  const desiredPort = opts.port ?? 4321;

  const clients = makeClientSet();

  const server = createServer((req, res) => {
    // SSE endpoint for live-reload.
    if (req.url === '/__livereload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      // Flush headers immediately so the client's EventSource 'open' fires on
      // connect rather than waiting for the first body write (the 20s heartbeat).
      res.flushHeaders();
      res.write(':ok\n\n');
      // Heartbeat every 20s to prevent proxy timeouts.
      const heartbeat = setInterval(() => {
        try { res.write(':ping\n\n'); } catch { clearInterval(heartbeat); }
      }, 20_000);
      res.on('close', () => clearInterval(heartbeat));
      clients.add(res);
      return;
    }

    // Decode URL path; strip query string.
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // Resolve to an absolute path.
    const absPath = resolve(join(root, urlPath));

    // Path-traversal guard.
    if (!isSafe(root, absPath)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    // Stat the target.
    let st;
    try {
      st = statSync(absPath);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }

    if (st.isDirectory()) {
      // Try index.html first.
      const indexPath = join(absPath, 'index.html');
      if (existsSync(indexPath)) {
        return serveFile(res, indexPath, reload, clients);
      }
      // Fallback: minimal directory listing.
      const listing = dirListing(absPath, urlPath);
      if (listing === null) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = reload ? injectReloadSnippet(listing) : listing;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }

    if (st.isFile()) {
      return serveFile(res, absPath, reload, clients);
    }

    res.writeHead(404).end('not found');
  });

  // Start watcher only when reload is enabled.
  let watcher = null;

  return new Promise((resolve_, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port busy — let the OS pick one instead by binding :0.
        // If desiredPort was already 0 this shouldn't loop; just reject.
        if (desiredPort !== 0) {
          server.listen(0, '127.0.0.1');
        } else {
          reject(err);
        }
        return;
      }
      reject(err);
    });

    server.listen(desiredPort, '127.0.0.1', () => {
      const { port } = server.address();

      if (reload) {
        watcher = watchDir(root, () => {
          clients.broadcast('reload');
        });
      }

      if (opts.open) {
        // Open the first top-level *.html found (or the base URL).
        openBrowser(root, port);
      }

      const close = () => new Promise((res_) => {
        if (watcher) watcher.close();
        server.close(() => res_());
      });

      resolve_({ server, port, close });
    });
  });
}

// ---------------------------------------------------------------------------
// Serve a single file
// ---------------------------------------------------------------------------
function serveFile(res, absPath, reload, _clients) {
  let body;
  try {
    body = readFileSync(absPath);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  const mime = mimeFor(absPath);
  const isHtml = mime.startsWith('text/html');

  if (isHtml && reload) {
    const html = body.toString('utf8');
    const injected = injectReloadSnippet(html);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(injected);
  } else {
    res.writeHead(200, { 'Content-Type': mime });
    res.end(body);
  }
}

// ---------------------------------------------------------------------------
// Open browser (best-effort; errors are silently swallowed)
// ---------------------------------------------------------------------------
function openBrowser(root, port) {
  // Find the first top-level *.html to open; fall back to the base URL.
  let target = `http://localhost:${port}/`;
  try {
    const htmlFiles = readdirSync(root).filter((f) => f.toLowerCase().endsWith('.html'));
    if (htmlFiles.length > 0) {
      target = `http://localhost:${port}/${encodeURIComponent(htmlFiles[0])}`;
    }
  } catch { /* ignore */ }

  const platform = process.platform;
  let cmd, args;
  if (platform === 'darwin') {
    cmd = 'open'; args = [target];
  } else if (platform === 'win32') {
    cmd = 'cmd'; args = ['/c', 'start', '', target];
  } else {
    cmd = 'xdg-open'; args = [target];
  }

  execFile(cmd, args, { timeout: 5000 }, () => { /* ignore errors */ });
}

// ---------------------------------------------------------------------------
// CLI helper: print startup banner (called from claude-design.mjs cmdServe)
// ---------------------------------------------------------------------------
export function printBanner(dir, port, reload) {
  const base = `http://localhost:${port}`;
  console.log(base);

  // Enumerate top-level *.html and print direct links.
  try {
    const htmlFiles = readdirSync(resolve(dir)).filter((f) => f.toLowerCase().endsWith('.html'));
    for (const f of htmlFiles) {
      console.log(`  ${base}/${encodeURIComponent(f)}`);
    }
  } catch { /* ignore */ }

  const reloadNote = reload ? ' (live-reload on)' : ' (live-reload off)';
  console.log(`serving ${dir}${reloadNote} — press Ctrl-C to stop`);
}
