// HTTP 응답·오류·CORS·서명 토큰 공통부.
import type { Config } from './env.ts';

/** 04 §7 오류 코드 + API 전용 코드 */
export type ApiCode =
  | 'AUTH_REQUIRED' | 'AUTH_NOT_CONFIGURED' | 'FORBIDDEN' | 'NOT_FOUND' | 'ORIGIN_FORBIDDEN' | 'CONFIG_REFUSED'
  | 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE' | 'QUOTA' | 'RATE_LIMITED' | 'UPLOAD_EXPIRED' | 'UPLOAD_INCOMPLETE'
  | 'HASH_MISMATCH' | 'REF_NOT_READY' | 'REVISION_MISMATCH' | 'REVISION_EXISTS' | 'IDEMPOTENCY_MISMATCH'
  | 'REMOTE_CONFLICT' | 'PROJECT_DELETED' | 'DB_ERROR' | 'OBJECT_CHANGED';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ApiCode, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const errorResponse = (e: ApiError) => json({ error: e.code, message: e.message, ...e.extra }, e.status, e.code === 'RATE_LIMITED' ? { 'retry-after': String(e.extra.retryAfterSec ?? 60) } : {});

export function corsHeaders(origin: string | null, cfg: Config | null): Record<string, string> {
  if (!origin || !cfg || !cfg.origins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin, vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-expose-headers': 'retry-after',
    'access-control-max-age': '600',
  };
}

// ---------------- crypto ----------------
const enc = new TextEncoder();
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
export async function sha256(data: Uint8Array | string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', (typeof data === 'string' ? enc.encode(data) : data) as BufferSource)); }

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = keys.get(secret);
  if (!k) { k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); keys.set(secret, k); }
  return k;
}
/** payload 를 HMAC 서명한 compact 토큰: <prefix>.<b64url(json)>.<b64url(sig)> */
export async function signToken(secret: string, prefix: string, payload: Record<string, unknown>): Promise<string> {
  const body = `${prefix}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}
export async function verifyToken<T>(secret: string, prefix: string, token: string): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(parts[2]) as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
    return ok ? JSON.parse(new TextDecoder().decode(unb64url(parts[1]))) as T : null;
  } catch { return null; }
}

/** 요청 JSON 읽기(크기 제한) */
export async function readJson<T>(req: Request, maxBytes = 4 * 1024 * 1024): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `body > ${maxBytes}`);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `body > ${maxBytes}`);
  try { return JSON.parse(new TextDecoder().decode(buf)) as T; } catch { throw new ApiError(400, 'BAD_REQUEST', 'invalid JSON'); }
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export function needId(v: unknown, what: string): string { if (typeof v !== 'string' || !ID_RE.test(v)) throw new ApiError(400, 'BAD_REQUEST', `${what} must be an id`); return v; }
export function needHash(v: unknown, what: string): string { if (typeof v !== 'string' || !HASH_RE.test(v)) throw new ApiError(400, 'BAD_REQUEST', `${what} must be a lowercase sha256`); return v; }
