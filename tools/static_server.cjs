const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4173;
const ROOT = path.join(__dirname, "..", "site");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

function resolveRoute(urlPath) {
  // Remove query string
  urlPath = urlPath.split("?")[0];

  // Root
  if (urlPath === "/") return "/index.html";

  // Gym Join
  if (/^\/gym\/[^/]+\/join$/.test(urlPath)) {
    return "/gym/join/index.html";
  }

  // Booking
  if (/^\/app\/book\/class\/[^/]+$/.test(urlPath)) {
    return "/app/book/class/index.html";
  }

  // Biz migrate routes
  if (urlPath.startsWith("/biz/migrate/members")) {
    return "/biz/migrate/members/index.html";
  }

  if (urlPath.startsWith("/biz/migrate/schedule")) {
    return "/biz/migrate/schedule/index.html";
  }

  if (urlPath.startsWith("/biz/migrate/verify")) {
    return "/biz/migrate/verify/index.html";
  }

  if (urlPath.startsWith("/biz/migrate/commit")) {
    return "/biz/migrate/commit/index.html";
  }

  if (urlPath.startsWith("/biz/migrate/cutover")) {
    return "/biz/migrate/cutover/index.html";
  }

  if (urlPath.startsWith("/biz/migrate")) {
    return "/biz/migrate/index.html";
  }

  if (urlPath.startsWith("/biz/check-in")) {
    return "/biz/check-in/index.html";
  }

  // If exact file exists, serve it
  return urlPath;
}

const server = http.createServer((req, res) => {
  let filePath = resolveRoute(req.url);
  filePath = path.join(ROOT, filePath);

  // If directory, serve index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const type = MIME[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`NDYRA local server running at http://localhost:${PORT}`);
  console.log(`Serving from: ${ROOT}`);
});