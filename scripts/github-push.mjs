/**
 * Cria um repositório público no GitHub e envia a branch main.
 * Usa o token salvo por scripts/github-device.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = fs.readFileSync(path.join(ROOT, ".runtime", "github.token"), "utf8").trim();
const REPO_NAME = process.env.GITHUB_REPO || "multi-bet-platform";
const GIT = process.env.GIT_BIN || path.join(ROOT, ".runtime", "git", "cmd", "git.exe");

if (!TOKEN) {
  console.error("Token do GitHub não encontrado.");
  process.exit(1);
}

async function gh(method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "multi-bet-deploy",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${endpoint} → HTTP ${res.status}: ${text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const user = await gh("GET", "/user");
console.log(`GitHub: ${user.login} (${user.name || user.email || "sem nome"})`);

let repo;
try {
  repo = await gh("POST", "/user/repos", {
    name: REPO_NAME,
    description: "Plataforma multi-bet multi-tenant (demo)",
    private: false,
    auto_init: false,
    has_issues: false,
    has_wiki: false,
  });
  console.log(`Repositório criado: ${repo.html_url}`);
} catch (err) {
  if (err.status === 422) {
    repo = await gh("GET", `/repos/${user.login}/${REPO_NAME}`);
    console.log(`Repositório já existente: ${repo.html_url}`);
  } else {
    throw err;
  }
}

const pushUrl = `https://x-access-token:${TOKEN}@github.com/${user.login}/${REPO_NAME}.git`;
const result = spawnSync(GIT, ["push", pushUrl, "main:main"], {
  cwd: ROOT,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  encoding: "utf8",
  timeout: 180_000,
});

if (result.status !== 0) {
  console.error(result.stdout || "");
  console.error(result.stderr || "");
  throw new Error(`git push falhou (código ${result.status}).`);
}

// Remove o token da URL do remote: mantém apenas a URL pública.
spawnSync(GIT, ["remote", "remove", "origin"], { cwd: ROOT });
spawnSync(GIT, ["remote", "add", "origin", repo.clone_url], { cwd: ROOT });

const cloneUrl = `https://github.com/${user.login}/${REPO_NAME}.git`;
const info = {
  owner: user.login,
  name: REPO_NAME,
  htmlUrl: repo.html_url,
  cloneUrl,
  branch: "main",
  pushedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(ROOT, ".runtime", "github-repo.json"),
  JSON.stringify(info, null, 2),
  "utf8"
);
fs.writeFileSync(path.join(ROOT, ".runtime", "github-url.txt"), cloneUrl + "\n", "utf8");

console.log("GITHUB_PUSH_OK");
console.log("REPO_URL=" + cloneUrl);
