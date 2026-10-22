// 用 Logto Management API 幂等创建：API Resource / Scope / Role / Application
// 前置：在 http://localhost:3002 里建一个 M2M 应用，授予 "Logto Management API" 权限，
//      把 client id / secret 写进 .env 的 M2M_CLIENT_ID / M2M_CLIENT_SECRET。
// 用法：npm run provision

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ENDPOINT = (process.env.LOGTO_ENDPOINT ?? "http://localhost:3001").replace(/\/$/, "");
const ADMIN = (process.env.LOGTO_ADMIN_ENDPOINT ?? "http://localhost:3002").replace(/\/$/, "");
const CLIENT_ID = process.env.M2M_CLIENT_ID;
const CLIENT_SECRET = process.env.M2M_CLIENT_SECRET;
// Management API 的 indicator 随版本不同：自托管 ≥1.22 是 https://default.logto.app/api，
// 老版本是 https://logto.dev/api。依次尝试，哪个能换到 token 用哪个。
const MGMT_RESOURCE_CANDIDATES = [
  process.env.MGMT_RESOURCE,
  "https://default.logto.app/api",
  "https://logto.dev/api",
  "https://api.logto.io",
].filter(Boolean);

// 注意：Logto 自托管把不同租户的 Management API 挂在各自端点下。
// 在管理后台（3002）里创建的机器身份属于 default 租户，它的 Management API 在 3001。
// 可用 LOGTO_MGMT_ENDPOINT 覆盖（例如 M2M 属于 admin 租户时填 3002）。
const MGMT_API = (process.env.LOGTO_MGMT_ENDPOINT ?? ENDPOINT).replace(/\/$/, "");

const GATEWAY = "https://api.gateway.local";
const RAG = "https://api.rag.local";
const AI = "https://api.ai.local";

const RESOURCES = [
  {
    name: "MCP 网关 API",
    indicator: GATEWAY,
    scopes: {
      "gateway:read": "查看上游、工具、仪表盘",
      "gateway:write": "修改上游、发 API Key、跑回归",
      "gateway:sensitive": "查看审计明细、变更记录、API Key、备份、上游连接配置",
    },
  },
  {
    name: "RAG 服务 API",
    indicator: RAG,
    scopes: {
      "rag:query": "检索知识库",
      "rag:admin": "管理知识库与文档",
    },
  },
  {
    name: "AI 应用 API",
    indicator: AI,
    scopes: {
      "ai:chat": "使用对话与智能体",
    },
  },
];

const ROLES = [
  {
    name: "platform_admin",
    type: "User",
    scopes: [
      `${GATEWAY}|gateway:read`,
      `${GATEWAY}|gateway:write`,
      `${GATEWAY}|gateway:sensitive`,
      `${RAG}|rag:query`,
      `${RAG}|rag:admin`,
      `${AI}|ai:chat`,
    ],
  },
  {
    name: "gateway_admin",
    type: "User",
    scopes: [
      `${GATEWAY}|gateway:read`,
      `${GATEWAY}|gateway:write`,
      `${GATEWAY}|gateway:sensitive`,
    ],
  },
  { name: "gateway_viewer", type: "User", scopes: [`${GATEWAY}|gateway:read`] },
  { name: "rag_admin", type: "User", scopes: [`${RAG}|rag:query`, `${RAG}|rag:admin`] },
  { name: "rag_user", type: "User", scopes: [`${RAG}|rag:query`] },
  { name: "app_user", type: "User", scopes: [`${AI}|ai:chat`] },
  { name: "rag_service_client", type: "MachineToMachine", scopes: [`${RAG}|rag:query`] },
  // 冒烟脚本用的机器身份：只用于本地/CI 跑回归，生产环境不要下发
  {
    name: "gateway_ci",
    type: "MachineToMachine",
    scopes: [`${GATEWAY}|gateway:read`, `${GATEWAY}|gateway:write`, `${GATEWAY}|gateway:sensitive`],
  },
];

const APPS = [
  {
    name: "MCP 网关管理后台",
    type: "SPA",
    origin: (process.env.MCP_WEB_ORIGIN ?? "http://localhost:5173").replace(/\/$/, ""),
  },
  {
    name: "AI 应用前端",
    type: "SPA",
    origin: (process.env.AI_WEB_ORIGIN ?? "http://localhost:5174").replace(/\/$/, ""),
  },
  { name: "AI 后端服务", type: "MachineToMachine", roles: ["rag_service_client"] },
  { name: "MCP 网关冒烟客户端", type: "MachineToMachine", roles: ["gateway_ci"] },
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    [
      "缺少 M2M_CLIENT_ID / M2M_CLIENT_SECRET。",
      "",
      "先在管理后台创建机器身份：",
      `  1. 打开 ${ADMIN}`,
      "  2. Applications → Create application → Machine-to-machine",
      "  3. 类型选 Logto Management API，权限勾选所有（或至少 Applications/Roles/Resources 的读写）",
      "  4. 把 Client ID / Client Secret 填进 .env",
      "",
      "这是唯一一次手工操作；之后所有配置都由本脚本幂等完成。",
    ].join("\n"),
  );
  process.exit(1);
}

async function request(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const message = typeof json === "object" && json?.message ? json.message : text.slice(0, 300);
    throw new Error(`${method} ${url} → HTTP ${res.status} ${message}`);
  }
  return json;
}

async function getManagementToken() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  let lastError = "";

  for (const resource of MGMT_RESOURCE_CANDIDATES) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      resource,
      scope: "all",
    });

    const res = await fetch(`${ENDPOINT}/oidc/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok && json.access_token) {
      console.log(`Management API resource: ${resource}`);
      return json.access_token;
    }
    lastError = `HTTP ${res.status} ${json.error_description ?? json.error ?? ""} (${resource})`;
  }

  throw new Error(
    `换取 Management token 失败：${lastError}\n` +
      `检查 M2M 应用是否被授予了 "Logto Management API" 权限。`,
  );
}

let token;
const api = (method, path, body) =>
  request(`${MGMT_API}/api${path}`, { method, headers: { authorization: `Bearer ${token}` }, body });

async function listAll(path) {
  const items = [];
  let page = 1;
  for (;;) {
    const separator = path.includes("?") ? "&" : "?";
    const res = await api("GET", `${path}${separator}page=${page}&page_size=100`);
    items.push(...(res ?? []));
    if (!Array.isArray(res) || res.length < 100) return items;
    page += 1;
  }
}

async function ensureResources() {
  const existing = await listAll("/resources?includeScopes=true");
  const scopeIds = new Map();
  const log = [];

  for (const desired of RESOURCES) {
    let resource = existing.find((r) => r.indicator === desired.indicator);

    if (!resource) {
      resource = await api("POST", "/resources", {
        name: desired.name,
        indicator: desired.indicator,
        accessTokenTtl: 900,
      });
      log.push(`  + API Resource ${desired.name} (${desired.indicator})`);
    } else {
      log.push(`  = API Resource ${desired.name}`);
    }

    const scopes = [...(resource.scopes ?? [])];
    for (const [name, description] of Object.entries(desired.scopes)) {
      let scope = scopes.find((s) => s.name === name);
      if (!scope) {
        scope = await api("POST", `/resources/${resource.id}/scopes`, { name, description });
        scopes.push(scope);
        log.push(`    + scope ${name}`);
      }
      scopeIds.set(`${desired.indicator}|${name}`, scope.id);
    }
  }

  return { scopeIds, log };
}

/**
 * 给角色绑定 scope：只 POST 差集。
 * 一次性提交全部 id 时，只要有一个已绑定，整个请求会 422 被拒，
 * 导致"给已有角色补新 scope"静默失效。
 */
async function assignScopes(roleId, scopeIds) {
  const existing = await listAll(`/roles/${roleId}/scopes`);
  const have = new Set((existing ?? []).map((s) => s.id));
  const missing = scopeIds.filter((id) => !have.has(id));
  if (missing.length === 0) return;
  await api("POST", `/roles/${roleId}/scopes`, { scopeIds: missing });
}

async function ensureRoles(scopeIds) {
  const existing = await listAll("/roles");
  const roleIds = new Map();
  const log = [];

  for (const desired of ROLES) {
    const ids = desired.scopes.map((key) => {
      const id = scopeIds.get(key);
      if (!id) throw new Error(`找不到 scope：${key}（检查 RESOURCES 定义）`);
      return id;
    });

    let role = existing.find((r) => r.name === desired.name);
    if (!role) {
      role = await api("POST", "/roles", {
        name: desired.name,
        description: desired.scopes.map((s) => s.split("|")[1]).join(", "),
        type: desired.type,
      });
      log.push(`  + Role ${desired.name} (${desired.type})`);
    } else {
      log.push(`  = Role ${desired.name}`);
    }

    await assignScopes(role.id, ids);
    roleIds.set(desired.name, role.id);
  }

  return { roleIds, log };
}

async function ensureApplications(roleIds) {
  const existing = await listAll("/applications");
  const log = [];
  const created = [];

  for (const desired of APPS) {
    let app = existing.find((a) => a.name === desired.name);

    if (!app) {
      const payload = { name: desired.name, type: desired.type, description: "由 provision.mjs 创建" };
      if (desired.type === "SPA") {
        payload.oidcClientMetadata = {
          redirectUris: [`${desired.origin}/callback`],
          postLogoutRedirectUris: [`${desired.origin}/`],
          corsAllowedOrigins: [desired.origin],
        };
      }
      app = await api("POST", "/applications", payload);
      log.push(`  + Application ${desired.name} (${desired.type})`);
    } else {
      log.push(`  = Application ${desired.name}`);
    }

    if (desired.roles?.length) {
      const ids = desired.roles.map((name) => {
        const id = roleIds.get(name);
        if (!id) throw new Error(`角色未创建：${name}`);
        return id;
      });
      await api("POST", `/applications/${app.id}/roles`, { roleIds: ids });
    }

    const detail =
      app.type === "SPA"
        ? app
        : { ...(await api("GET", `/applications/${app.id}`)), secret: await firstSecret(app.id) };
    created.push({ name: desired.name, type: desired.type, ...detail });
  }

  return { created, log };
}

/** M2M 应用的 secret 只在创建响应里出现一次，之后要从 secrets 接口取 */
async function firstSecret(appId) {
  const secrets = await api("GET", `/applications/${appId}/secrets`);
  return Array.isArray(secrets) && secrets.length > 0 ? secrets[0].value : "(控制台可查看/重置)";
}

/**
 * Account Center（Logto 自带的终端用户自助页，路径 /account）。
 *
 * 默认关闭，开启后才能让用户自己改资料/密码/MFA/会话。
 * email / phone 暂设 ReadOnly：本租户未配置邮件/SMS connector，
 * 改标识符需要发验证码，配好 connector 后再改成 Edit 即可。
 */
const ACCOUNT_CENTER = {
  enabled: true,
  fields: {
    name: "Edit",
    avatar: "Edit",
    // 登录名由管理员维护（用户不可自助改掉自己的登录凭证），展示名走 name
    username: "ReadOnly",
    profile: "Edit",
    email: "ReadOnly",
    phone: "ReadOnly",
    password: "Edit",
    mfa: "Edit",
    session: "Edit",
    trustedDevice: "ReadOnly",
    social: "Off",
    customData: "Off",
    passkey: "Off",
  },
  webauthnRelatedOrigins: [ENDPOINT],
};

async function ensureAccountCenter() {
  await api("PATCH", "/account-center", ACCOUNT_CENTER);
  return `  = Account Center 已启用（${ENDPOINT}/account）`;
}

async function main() {
  console.log(`Logto: ${ADMIN}\n`);
  token = await getManagementToken();
  console.log("Management token 获取成功\n");

  console.log("[1/4] API Resource 与 Scope");
  const { scopeIds, log: resourceLog } = await ensureResources();
  console.log(resourceLog.join("\n") || "  (无变化)");

  console.log("\n[2/4] Role");
  const { roleIds, log: roleLog } = await ensureRoles(scopeIds);
  console.log(roleLog.join("\n") || "  (无变化)");

  console.log("\n[3/4] Application");
  const { created, log: appLog } = await ensureApplications(roleIds);
  console.log(appLog.join("\n") || "  (无变化)");

  console.log("\n[4/4] Account Center");
  console.log(await ensureAccountCenter());

  console.log("\n接入参数");
  console.log(`  LOGTO_ENDPOINT      ${ENDPOINT}`);
  console.log(`  LOGTO_ISSUER        ${ENDPOINT}/oidc`);
  console.log(`  GATEWAY_AUDIENCE    ${GATEWAY}`);
  for (const app of created) {
    console.log("");
    console.log(`  ${app.name} (${app.type})`);
    console.log(`    app id   ${app.id}`);
    if (app.type === "SPA") {
      const meta = app.oidcClientMetadata ?? {};
      console.log(`    redirect ${(meta.redirectUris ?? []).join(", ")}`);
      console.log(`    CORS     ${(meta.corsAllowedOrigins ?? []).join(", ")}`);
    } else {
      console.log(`    secret   ${app.secret ?? "(控制台可查看/重置)"}`);
    }
  }
  console.log(`
完成。下一步：
  1. 把上面的参数填进各项目的前端环境变量（VITE_LOGTO_ENDPOINT / VITE_LOGTO_APP_ID）
  2. 后端用 @auth/verify 的 createVerifier({ issuer, audience })
  3. 去管理后台把角色分配给用户（Roles → 成员）
`);
}

main().catch((err) => {
  console.error(`\n失败：${err.message}`);
  process.exit(1);
});
