// 인증 adapter 경계(04 §5). 모든 API 는 인증 세션을 ownerId 로 해석하며 request 의 ownerId 는 읽지 않는다.
// 실제 공급자(D07 미정)는 AuthAdapter 를 구현해 추가한다. 현재 구현: none(거절), fake(로컬 개발 전용 HMAC 토큰).
// 세션은 Authorization: Bearer 헤더로만 전달한다(쿠키 없음 → CSRF 대상 아님). 쿠키 세션 공급자를 고르면
// SameSite + CSRF token + Origin 검사를 추가해야 한다(docs/decisions/0010).
import type { Config, Env } from './env.ts';
import { ApiError, signToken, verifyToken } from './http.ts';

export interface Session { ownerId: string; expiresAt: number }
export interface AuthAdapter { resolve(req: Request): Promise<Session | null> }

const USER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function authAdapter(env: Env, cfg: Config, now: () => number): AuthAdapter {
  if (cfg.authMode === 'fake') {
    const secret = env.FAKE_AUTH_SECRET!;
    return {
      async resolve(req) {
        const h = req.headers.get('authorization') ?? '';
        if (!h.startsWith('Bearer ')) return null;
        const p = await verifyToken<{ sub: string; exp: number }>(secret, 'fake1', h.slice(7));
        if (!p || typeof p.sub !== 'string' || !USER_RE.test(p.sub) || !(p.exp > now())) return null;
        return { ownerId: `fake:${p.sub}`, expiresAt: p.exp };
      },
    };
  }
  return { async resolve() { throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'login provider is not configured (D07)'); } };
}

/** POST /v1/dev/login — fake 모드(development+localhost, loadConfig 가 보장)에서만 존재한다. */
export async function fakeLogin(env: Env, cfg: Config, body: { user?: unknown; ttlSec?: unknown }, now: number) {
  if (cfg.authMode !== 'fake') throw new ApiError(404, 'NOT_FOUND', 'not found');
  const user = String(body.user ?? '');
  if (!USER_RE.test(user)) throw new ApiError(400, 'BAD_REQUEST', 'user must match [a-z0-9-]{1,32}');
  const ttl = Math.min(Math.max(Number(body.ttlSec ?? 3600), 1), 12 * 3600);
  const exp = now + ttl * 1000;
  return { token: await signToken(env.FAKE_AUTH_SECRET!, 'fake1', { sub: user, exp }), ownerId: `fake:${user}`, expiresAt: exp, provider: 'fake (development only)' };
}
