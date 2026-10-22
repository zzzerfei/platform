import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface VerifierOptions {
  /** 例：http://localhost:3001/oidc （Logto 的 issuer，结尾没有斜杠） */
  issuer: string;
  /** 例：https://api.gateway.local （API Resource 的 indicator，即 token 的 aud） */
  audience: string;
  /** 默认 `${issuer}/jwks`；Logto 就是这个路径，一般不用传 */
  jwksUri?: string;
  /** 允许的时钟偏移，默认 30 秒 */
  clockToleranceSec?: number;
}

export interface AuthUser {
  /** 用户 ID（人）或应用 ID（M2M） */
  sub: string;
  name?: string;
  username?: string;
  email?: string;
  /** 签发方应用（Application）的 client_id */
  clientId?: string;
  /** token 里的 scope，已拆成数组 */
  scopes: string[];
  /** 仅当你在 Logto 里配置了 custom claims 才会有值 */
  roles: string[];
  /** 原始 payload，需要别的字段时自取 */
  raw: JWTPayload;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 401, code = "unauthorized") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export type VerifyToken = (token: string) => Promise<AuthUser>;

/** 从 Authorization 头里取出 Bearer token，取不到返回 undefined */
export function readBearer(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

/**
 * 创建一个本地验签函数。
 *
 * 公钥由 jose 缓存，只有第一次（或 key 轮换、缓存过期）才会去拉 JWKS，
 * 因此业务服务不需要在每次请求时访问 Logto，也不需要读它的数据库。
 */
export function createVerifier(options: VerifierOptions): VerifyToken {
  const { issuer, audience, jwksUri, clockToleranceSec = 30 } = options;

  if (!issuer) throw new Error("createVerifier: issuer 必填");
  if (!audience) throw new Error("createVerifier: audience 必填");

  const jwks = createRemoteJWKSet(new URL(jwksUri ?? `${issuer.replace(/\/$/, "")}/jwks`), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
  });

  return async function verify(token: string): Promise<AuthUser> {
    let payload: JWTPayload;

    try {
      const result = await jwtVerify(token, jwks, {
        issuer,
        audience,
        clockTolerance: clockToleranceSec,
        algorithms: ["RS256", "PS256", "ES256", "ES384"],
      });
      payload = result.payload;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new AuthError(`token 校验失败：${reason}`);
    }

    if (!payload.sub) throw new AuthError("token 缺少 sub");

    return {
      sub: payload.sub,
      name: typeof payload.name === "string" ? payload.name : undefined,
      username: typeof payload.username === "string" ? payload.username : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
      scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
      roles: Array.isArray(payload.roles)
        ? payload.roles.filter((r): r is string => typeof r === "string")
        : [],
      raw: payload,
    };
  };
}

/** 校验 scope，缺一个就抛 403 */
export function assertScopes(user: AuthUser, ...required: string[]): void {
  if (required.length === 0) return;
  const missing = required.filter((scope) => !user.scopes.includes(scope));
  if (missing.length > 0) {
    throw new AuthError(`缺少权限：${missing.join(", ")}`, 403, "forbidden");
  }
}

export interface AuthMiddlewareOptions {
  verifier: VerifyToken;
  /** 需要的 scope，全部满足才放行 */
  scopes?: string[];
  /** 验签通过后挂到 req 上的字段名，默认 user */
  reqKey?: string;
}

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

interface ResLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/**
 * Express / NestJS(HTTP adapter) 通用中间件。
 * 认证失败必须 fail-closed：没有有效 token 就是 401，不能退化成匿名访问。
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { verifier, scopes = [], reqKey = "user" } = options;

  return async function authMiddleware(req: ReqLike, res: ResLike, next: (err?: unknown) => void) {
    try {
      const token = readBearer(req.headers);
      if (!token) throw new AuthError("缺少 Bearer token");

      const user = await verifier(token);
      assertScopes(user, ...scopes);

      req[reqKey] = user;
      next();
    } catch (err) {
      const authError =
        err instanceof AuthError
          ? err
          : new AuthError(err instanceof Error ? err.message : "认证失败", 500, "auth_unavailable");

      res.statusCode = authError.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (authError.status === 401) res.setHeader("www-authenticate", "Bearer");
      res.end(JSON.stringify({ error: authError.code, message: authError.message }));
    }
  };
}
