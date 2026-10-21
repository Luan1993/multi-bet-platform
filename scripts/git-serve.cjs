/**
 * Servidor HTTP somente-leitura para um repositório Git "bare" (protocolo dumb HTTP).
 * Usado apenas para o deploy inicial quando não há GitHub/GitLab configurado.
 *
 * Uso: node scripts/git-serve.cjs [porta] [caminho-do-repo-bare]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || process.env.GIT_PORT || 4100);
const REPO = path.resolve(
  process.argv[3] || path.join(__dirname, "..", ".runtime", "deploy-repo.git")
);
const PREFIX = "/deploy-repo.git";

const TYPES = {
  ".pack": "application/octet-stream",
  ".idx": "application/octet-stream",
  ".rev": "application/octet-stream",
  ".bitmap": "application/octet-stream",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "method not allowed");
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "bad request");
  }

  if (!pathname.startsWith(PREFIX + "/")) {
    return send(res, 404, "not found");
  }

  const relative = pathname.slice(PREFIX.length + 1);
  const file = path.resolve(REPO, relative);
  if (!file.startsWith(REPO + path.sep)) {
    return send(res, 403, "forbidden");
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, "not found");
  }
  if (!stat.isFile()) return send(res, 404, "not found");

  const type = TYPES[path.extname(file)] || "text/plain; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[git] servindo ${REPO} em http://127.0.0.1:${PORT}${PREFIX}`);
});
