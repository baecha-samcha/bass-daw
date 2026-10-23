// 개발 전용 fake 로그인(로컬 API 서버의 /v1/dev/login). production 빌드에는 포함되지 않는다:
// cloud.ts 가 import.meta.env.MODE !== 'production' 분기 안에서만 동적 import 한다(scripts/check-prod-bundle.mjs 로 확인).
export async function fakeLogin(base: string, user: string, ttlSec?: number, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const r = await fetchImpl(`${base}/v1/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, ttlSec }) });
  if (!r.ok) throw new Error(`login failed: HTTP ${r.status}`);
  return await r.json() as { token: string; ownerId: string; expiresAt: number };
}
