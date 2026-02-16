#!/usr/bin/env node
/**
 * Tiny static server for Playwright E2E.
 * Why: avoids SPA-rewrite quirks and guarantees querystrings don't affect file resolution.
 *
 * Usage:
 *   node tools/static_server.cjs --root site --port 4174
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function arg(name, fallback=null){
  const idx = process.argv.indexOf(`--${name}`);
  if(idx === -1) return fallback;
  const val = process.argv[idx+1];
  if(!val || val.startsWith('--')) return fallback;
  return val;
}

const ROOT = path.resolve(arg('root', 'site'));
const PORT = Number(arg('port', process.env.PW_PORT || 4174));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function contentType(filePath){
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function safeJoin(root, rel){
  const joined = path.join(root, rel);
  const normRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if(!joined.startsWith(normRoot)) return null;
  return joined;
}

const server = http.createServer((req, res) => {
  try{
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(u.pathname || '/');

    // Normalize directory -> index.html
    if(pathname.endsWith('/')) pathname += 'index.html';

    // Default to root index
    if(pathname === '') pathname = '/index.html';

    const rel = pathname.replace(/^\/+/, '');
    const filePath = safeJoin(ROOT, rel);

    // No traversal
    if(!filePath){
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, st) => {
      if(err || !st.isFile()){
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          // Prevent caching during E2E
          'Cache-Control': 'no-store'
        });
        res.end('Not Found');
        return;
      }

      // Stream file
      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }catch(e){
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`E2E static server: ${ROOT}`);
  console.log(`Listening on http://localhost:${PORT}`);
});
