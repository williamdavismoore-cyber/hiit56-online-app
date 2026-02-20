/**
 * NDYRA Static QA Server (no framework)
 *
 * Why this exists:
 * - Local QA + Playwright need deterministic routing for "pretty" URLs
 * - Must serve ES modules with correct MIME types (.mjs)
 * - Must NOT introduce a routing framework (Blueprint rule)
 *
 * Usage:
 *   node tools/static_server.cjs --root site --port 4173
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v ?? fallback;
}

const root = getArg('--root', 'site');
const port = Number(getArg('--port', '4174'));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/**
 * Pretty-URL route rewrites (Blueprint v7.3.1)
 *
 * IMPORTANT:
 * - These are ONLY rewrites to existing static HTML files.
 * - If the target file doesn't exist in the current build, rewrite is skipped.
 */
const routeMap = [
  // Existing
  { re: /^\/app\/post\/[0-9a-fA-F-]{36}\/?$/, file: '/app/post/index.html' },

  // Blueprint v7.3.1 (safe-guarded by existence checks)
  { re: /^\/app\/book\/class\/[0-9a-fA-F-]{36}\/?$/, file: '/app/book/class/index.html' },
  { re: /^\/gym\/[a-z0-9-]+\/join\/?$/i, file: '/gym/join/index.html' },
];

function existsUnderRoot(file) {
  try {
    fs.accessSync(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || '/');

  // Rewrite dynamic/pretty routes to their static entrypoints
  for (const r of routeMap) {
    if (r.re.test(pathname) && existsUnderRoot(r.file)) {
      pathname = r.file;
      break;
    }
  }

  // Normalize directory/extension-less paths to /index.html
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (!path.extname(pathname)) pathname = pathname.replace(/\/$/, '') + '/index.html';

  const absPath = path.join(root, pathname);

  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    const ct = CONTENT_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': ct,
      // Prevent weird caching issues during QA.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(port, '0.0.0.0', () => {
  // Print both localhost + LAN hints
  console.log(`Serving ${root} at:`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  http://127.0.0.1:${port}/`);
});
