// 检查 Logto 是否就绪：OIDC discovery / JWKS / Admin API
// 用法：npm run check

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ENDPOINT = (process.env.LOGTO_ENDPOINT ?? "http://localhost:3001").replace(/\/$/, "");
const ADMIN = (process.env.LOGTO_ADMIN_ENDPOINT ?? "http://localhost:3002").replace(/\/$/, "");
const TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, ok: res.ok, body };
}

async function waitForDiscovery() {
  const url = `${ENDPOINT}/oidc/.well-known/openid-configuration`;
  const started = Date.now();
  let lastError = "";

  process.stdout.write(`等待 Logto 就绪 ${url}\n`);
  while (Date.now() - started < TIMEOUT_MS) {
    try {
      const res = await getJson(url);
      if (res.ok && res.body?.issuer) return res.body;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    process.stdout.write(".");
    await sleep(3000);
  }

  throw new Error(
    `OIDC discovery 在 ${TIMEOUT_MS / 1000}s 内不可达（${lastError}）。\n` +
      `排查：docker compose ps / docker compose logs logto`,
  );
}

function printRow(label, value) {
  console.log(`  ${label.padEnd(12)} ${value}`);
}

const discovery = await waitForDiscovery();
console.log("\n[1/3] OIDC discovery");
printRow("issuer", discovery.issuer);
printRow("authorization", discovery.authorization_endpoint);
printRow("token", discovery.token_endpoint);
printRow("jwks", discovery.jwks_uri);
if (discovery.issuer !== `${ENDPOINT}/oidc`) {
  console.log(
    `\n  ! issuer 与 LOGTO_ENDPOINT 不一致：token 的 iss 会是 ${discovery.issuer}，\n` +
      `    业务侧 createVerifier({ issuer }) 必须用这个值，否则全部 401。`,
  );
}

console.log("\n[2/3] JWKS（业务侧验签用的公钥）");
const jwks = await getJson(discovery.jwks_uri);
if (!jwks.ok) throw new Error(`JWKS 拉取失败：HTTP ${jwks.status}`);
const keys = jwks.body?.keys ?? [];
printRow("keys", String(keys.length));
for (const key of keys) {
  printRow("kid", `${key.kid ?? "(none)"}  ${key.alg ?? ""} ${key.kty ?? ""}`);
}
if (keys.length === 0) throw new Error("JWKS 里没有公钥，Logto 可能还在初始化");

console.log("\n[3/3] Admin Console");
const status = await getJson(`${ADMIN}/api/status`);
printRow("status", `HTTP ${status.status}`);
if (!status.ok) {
  console.log("  ! 管理后台未就绪，稍后再试；不影响业务侧验签");
}

console.log(`
结论：Logto 已就绪。

下一步：
  1. 浏览器打开 ${ADMIN} 注册第一个管理员
  2. 创建 M2M 应用并勾选 Logto Management API 权限，把 client id / secret 填进 .env
  3. npm run provision   # 自动创建 API Resource / Scope / Role / 三个前端应用
`);
