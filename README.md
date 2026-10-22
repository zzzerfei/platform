# 统一身份平台（Logto）

三个项目（AI 应用 / RAG / MCP 网关）共用一套登录与权限。

- **认证集中**：只有 Logto 签发 token
- **授权分散**：MCP 网关管 tool 权限，RAG 管知识库 ACL，Logto 只管“你是谁 + 你有哪些 scope”
- **不查用户库**：业务服务拉一次 JWKS 本地验签，天然支持多副本

---

## 目录

```
auth-platform/
├── docker-compose.yml   # Logto + PostgreSQL
├── .env                 # 本地配置（不进 git）
├── packages/auth-verify # 共享验签包（jose）
└── scripts/
    ├── check.mjs        # 检查 OIDC discovery / JWKS / Admin API
    └── provision.mjs    # 幂等创建 API / Scope / Role / Application
```

---

## 启动

```bash
npm run up        # 起 Postgres + Logto
npm run check     # 等 Logto 就绪，并打印 issuer / JWKS
```

浏览器打开 **http://localhost:3002** 注册第一个管理员（首次初始化只能在浏览器完成）。

| 端口 | 用途 |
|---|---|
| 3001 | OIDC / Experience API（业务方访问） |
| 3002 | Admin Console（只有运维访问） |

数据在 Docker volume `pgdata`，`npm run down` 不会丢。

---

## 核心概念

| 概念 | 是什么 | 为什么 |
|---|---|---|
| **Application** | 一个接入方（SPA / 后端 / 机器） | 每端独立 client_id、回调地址、CORS |
| **API Resource** | 受保护的 API，用 `indicator` 标识 | 就是 token 的 `aud`，**不同服务不同 audience，token 不能串用** |
| **Permission / Scope** | API 上的权限点，如 `gateway:write` | 直接写进 token，业务侧不查库就能鉴权 |
| **Role** | 一组 scope 的集合 | 给人分配角色，而不是逐个勾权限 |
| **M2M Application** | 机器身份（client credentials） | 服务调服务不能借用用户 token |

> **Logto 只负责“你是谁 + 你有哪些 scope”。**
> 不要在这里配置“哪个角色能调哪个 tool”“谁能看哪个知识库”，那是业务权限，属于各项目自己的表。

---

## 三种接入方式

### 前端 SPA（Vue / React）

```bash
npm i @logto/vue      # React 用 @logto/react
```

```ts
import { createLogto } from '@logto/vue';

app.use(createLogto, {
  endpoint: 'http://localhost:3001',
  appId: import.meta.env.VITE_LOGTO_APP_ID,
  scopes: ['openid', 'profile', 'email'],
  resources: ['https://api.gateway.local'], // 决定 access token 的 audience
});
```

```ts
const { signIn, isAuthenticated, getAccessToken } = useLogto();
signIn(`${window.location.origin}/callback`);

const token = await getAccessToken('https://api.gateway.local');
fetch('/admin/api/upstreams', { headers: { Authorization: `Bearer ${token}` } });
```

SPA 存不住 client secret，**必须授权码 + PKCE**，SDK 已内置。

### 后端（NestJS / Express）

```ts
import { createVerifier, assertScopes } from '@auth/verify';

const verify = createVerifier({
  issuer: 'http://localhost:3001/oidc',
  audience: 'https://api.gateway.local',
});

@Injectable()
export class JwtGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = req.headers.authorization?.replace(/^Bearer /i, '');
    if (!token) throw new UnauthorizedException('缺少 token');
    req.user = await verify(token);
    assertScopes(req.user, 'gateway:read');
    return true;
  }
}
```

公钥会被 jose 缓存，**不是每个请求都去拉 JWKS**。

### 机器调用（AI 后端 → RAG）

```bash
curl -X POST http://localhost:3001/oidc/token \
  -u "$M2M_CLIENT_ID:$M2M_CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  -d "resource=https://api.rag.local" \
  -d "scope=rag:query"
```

拿到的 token 里 `sub` 是应用 ID。**不要转发用户 token**，那会抹掉服务间的权限边界。

---

## 初始化配置（一次）

1. 浏览器创建管理员
2. 建 M2M 应用，勾选 **Logto Management API** 权限
3. 把 Client ID / Secret 填进 `.env` 的 `M2M_CLIENT_ID` / `M2M_CLIENT_SECRET`
4. `npm run provision`

脚本会幂等创建：

- 3 个 API Resource：`api.gateway.local` / `api.rag.local` / `api.ai.local`
- 5 个 scope：`gateway:read` `gateway:write` `rag:query` `rag:admin` `ai:chat`
- 7 个角色：`platform_admin` `gateway_admin` `gateway_viewer` `rag_admin` `rag_user` `app_user` `rag_service_client`
- 3 个应用：MCP 管理后台（SPA）、AI 前端（SPA）、AI 后端（M2M）

---

## mcp-agent 的改造点

| 文件 | 改动 |
|---|---|
| `admin/guards/admin-token.guard.ts` | 换成 JwtGuard：验 `aud=https://api.gateway.local` + `gateway:read` |
| 各 controller 的 `actor(req)` | 改取 `req.user.sub`（现在是可伪造的 `x-admin-user` 头） |
| `api_keys` 表 | 加 `owner_user_id`，人禁用 → Key 一起失效 |

**MCP 通道的 API Key 体系不动**：那是给机器调工具的业务凭证，带限流、配额、审计。

---

## 上线前检查

- [ ] `ENDPOINT` / `ADMIN_ENDPOINT` 换 HTTPS 域名（issuer 变了所有 token 重配）
- [ ] 各 Application 回调地址改真实域名（Logto 精确匹配）
- [ ] `POSTGRES_PASSWORD` 换强随机值，`.env` 不进 git
- [ ] 3002 端口不对公网开放
- [ ] access token TTL 调短（900s），依赖 refresh token 轮换
- [ ] 备份 Postgres（身份数据丢了 = 全站用户丢失）
