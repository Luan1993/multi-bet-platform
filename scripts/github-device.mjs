/**
 * Autorização GitHub via OAuth Device Flow (mesmo fluxo do GitHub CLI).
 * Gera .runtime/github-device.json com o código e, após a autorização,
 * salva o token em .runtime/github.token.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // OAuth App público do GitHub CLI
const SCOPE = "repo";
const DEVICE_FILE = path.join(ROOT, ".runtime", "github-device.json");
const TOKEN_FILE = path.join(ROOT, ".runtime", "github.token");

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return data;
}

const start = await postForm("https://github.com/login/device/code", {
  client_id: CLIENT_ID,
  scope: SCOPE,
});

fs.writeFileSync(
  DEVICE_FILE,
  JSON.stringify(
    {
      verification_uri: start.verification_uri,
      user_code: start.user_code,
      expires_in: start.expires_in,
      interval: start.interval,
      created_at: new Date().toISOString(),
    },
    null,
    2
  )
);

console.log("GITHUB_DEVICE_CODE");
console.log("URL:", start.verification_uri);
console.log("CODE:", start.user_code);
console.log("EXPIRES_IN:", start.expires_in);

let interval = Math.max(5, Number(start.interval) || 5);
const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  const result = await postForm("https://github.com/login/oauth/access_token", {
    client_id: CLIENT_ID,
    device_code: start.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  if (result.access_token) {
    fs.writeFileSync(TOKEN_FILE, result.access_token + "\n", "utf8");
    console.log("GITHUB_AUTH_OK");
    process.exit(0);
  }
  if (result.error === "authorization_pending") {
    console.log("Aguardando autorização...");
    continue;
  }
  if (result.error === "slow_down") {
    interval += 5;
    console.log("Aguardando (slow_down)...");
    continue;
  }
  throw new Error(
    `Falha na autorização: ${result.error || "desconhecido"} ${result.error_description || ""}`
  );
}

throw new Error("Código expirado. Gere um novo código.");
