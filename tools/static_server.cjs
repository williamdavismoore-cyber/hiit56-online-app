#!/usr/bin/env node
/**
 * NDYRA static server for local QA + Playwright.
 * - Serves /site as static assets
 * - Mirrors Netlify rewrite rules for dynamic, static-routed pages (Blueprint v7.3.1)
 *
 * Usage:
 *   node tools/static_server.cjs --root site --port 4173
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const mime = require('mime');
const url = require('url');

const argv = require('minimist')(process.argv.slice(2));
const root = path.resolve(process.cwd(), argv.root || 'site');
const port = Number(argv.port || 4173);

// Route Map (matches Netlify _redirects)
// IMPORTANT: no new routing framework — just deterministic static rewrites.
const ROUTE_MAP = [
  // Existing dynamic route
  { match: /^\/app\/post\/[^/]+\/?$/i, to: '/app/post/index.html' },

  // Blueprint v7.3.1
  { match: /^\/gym\/[^/]+\/join\/?$/i, to: '/gym/join/index.html' },
  { match: /^\/app\/book\/class\/[^/]+\/?$/i, to: '/app/book/class/index.html' },
];

function rewritePathname(pathname) {
  // Normalize
  if (!pathname) return '/';
  // Strip query/hash already done by url.parse, but keep safety.
  pathname = pathname.split('?')[0].split('#')[0];

  // Netlify redirect: /app -> /app/fyp/ (QA visibility)
  if (pathname === '/app' || pathname === '/app/') return { redirect: '/app/fyp/' };

  for (const r of ROUTE_MAP) {
    if (r.match.test(pathname)) return { file: r.to };
  }
  return { file: pathname };
}

function send(res, code, headers, body) {
  res.writeHead(code, headers || {});
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
      return;
    }
    let contentType = mime.getType(filePath) || 'application/octet-stream';
    // Force correct MIME for ESM
    if (filePath.endsWith('.mjs')) contentType = 'application/javascript; charset=utf-8';
    send(res, 200, { 'Content-Type': contentType }, data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || '/';

  const routed = rewritePathname(pathname);

  if (routed.redirect) {
    send(res, 302, { Location: routed.redirect }, '');
    return;
  }

  let relPath = routed.file;

  // directory -> index.html
  if (relPath.endsWith('/')) relPath += 'index.html';

  // If they request a "pretty" URL without extension, try index.html.
  // Example: /biz/migrate -> /biz/migrate/index.html
  const hasExt = path.extname(relPath) !== '';
  let candidate = relPath;

  let filePath = path.join(root, candidate);
  if (!hasExt && fs.existsSync(path.join(root, relPath, 'index.html'))) {
    filePath = path.join(root, relPath, 'index.html');
  } else if (!hasExt && fs.existsSync(path.join(root, relPath + '.html'))) {
    filePath = path.join(root, relPath + '.html');
  }

  // Fallback: if the exact file doesn't exist, check index.html in that folder.
  if (!fs.existsSync(filePath)) {
    const maybeIndex = path.join(root, candidate, 'index.html');
    if (fs.existsSync(maybeIndex)) filePath = maybeIndex;
  }

  sendFile(res, filePath);
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Static server listening on http://localhost:${port} (root=${root})`);
});
