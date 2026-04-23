const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "latest.json");
const PUBLIC_DATA_FILE = path.join(PUBLIC_DIR, "latest.json");
const PUBLIC_SYNC_FILES = [
  { source: DATA_FILE, destination: PUBLIC_DATA_FILE },
  { source: path.join(DATA_DIR, "posts.json"), destination: path.join(PUBLIC_DIR, "posts.json") },
  {
    source: path.join(DATA_DIR, "concepts-complete.json"),
    destination: path.join(PUBLIC_DIR, "concepts-complete.json"),
  },
  {
    source: path.join(DATA_DIR, "meta-batch-results.json"),
    destination: path.join(PUBLIC_DIR, "meta-batch-results.json"),
  },
  {
    source: path.join(DATA_DIR, "prompt-variants.json"),
    destination: path.join(PUBLIC_DIR, "prompt-variants.json"),
  },
  {
    source: path.join(DATA_DIR, "bad-image-signatures.json"),
    destination: path.join(PUBLIC_DIR, "bad-image-signatures.json"),
  },
];

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

ensureDataFiles();

const server = http.createServer((request, response) => {
  const requestPath = normalizeRequestPath(request.url || "/");

  if (requestPath === "/api/latest") {
    return streamFile(DATA_FILE, response);
  }

  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!isWithinDirectory(filePath, PUBLIC_DIR)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  streamFile(filePath, response, () => {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
});

server.listen(PORT, () => {
  console.log(`Image Utility Panda v1 running at http://127.0.0.1:${PORT}`);
});

function normalizeRequestPath(urlValue) {
  const url = new URL(urlValue, "http://127.0.0.1");
  return decodeURIComponent(url.pathname);
}

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(PUBLIC_DIR, "generated"), { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const starterData = {
      prompt: "No image generated yet.",
      imagePath: null,
      generatedAt: null,
      status: "waiting",
    };

    fs.writeFileSync(DATA_FILE, `${JSON.stringify(starterData, null, 2)}\n`);
  }

  syncPublicDataFiles();
}

function streamFile(filePath, response, onMissing) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT" && typeof onMissing === "function") {
        onMissing();
        return;
      }

      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  });
}

function isWithinDirectory(targetPath, parentDirectory) {
  const relative = path.relative(parentDirectory, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    || path.resolve(targetPath) === path.resolve(parentDirectory, "index.html");
}

function syncPublicDataFiles() {
  for (const file of PUBLIC_SYNC_FILES) {
    if (!fs.existsSync(file.source)) {
      continue;
    }

    fs.copyFileSync(file.source, file.destination);
  }
}
