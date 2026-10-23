// API 테스트 하네스: 같은 Worker handle() 을 로컬 D1(node:sqlite)/R2 어댑터 위에서 in-process 로 호출한다.
import { createHash } from 'node:crypto';
import { handle } from '../src/app.ts';
import { localEnv } from '../local/env.ts';
import type { Env } from '../src/env.ts';
import { httpRemoteApi } from '../../web/src/sync/http-api.ts';
import { fakeLogin } from '../../web/src/sync/dev-auth.ts';
import { serializeProject, type Project } from '@bass-daw/schemas';
import type { RemoteApi } from '@bass-daw/storage';

export const BASE = 'http://localhost';
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export function setup(vars: Partial<Env> = {}) {
  let clock = Date.parse('2026-10-23T00:00:00Z');
  const env = localEnv({ vars: { CHUNK_BYTES: String(64 * 1024), VERIFY_BUDGET_BYTES: String(1024 * 1024), __now: () => clock, ...vars } });
  const calls: { method: string; path: string; status: number }[] = [];
  /** 장애 주입: 다음 요청을 네트워크 오류로/응답 유실로 */
  const faults: { match: RegExp; mode: 'network' | 'drop-response'; times: number }[] = [];
  const hooks: { onRequest: ((method: string, path: string) => void) | null } = { onRequest: null };
  const f: typeof fetch = async (input, init) => {
    const req = new Request(input as string, init);
    const path = new URL(req.url).pathname;
    hooks.onRequest?.(req.method, path);
    const fault = faults.find((x) => x.times > 0 && x.match.test(`${req.method} ${path}`));
    if (fault?.mode === 'network') { fault.times--; throw new TypeError('fetch failed (injected)'); }
    const res = await handle(req, env);
    calls.push({ method: req.method, path, status: res.status });
    if (fault?.mode === 'drop-response') { fault.times--; throw new TypeError('connection reset after request was processed (injected)'); }
    return res;
  };
  return {
    env, calls, faults, hooks, fetch: f,
    tick: (ms: number) => { clock += ms; },
    now: () => clock,
    login: (user: string, ttlSec?: number) => fakeLogin(BASE, user, ttlSec, f),
    api: (token: () => string | null): RemoteApi => httpRemoteApi(BASE, token, f),
    raw: (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
      f(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body as unknown as BodyInit : JSON.stringify(body) }),
  };
}
export type Harness = ReturnType<typeof setup>;

export const snapshotOf = (p: Project) => { const s = serializeProject(p); if (!s.ok) throw new Error(JSON.stringify(s.errors)); return s.value; };

/** 클라이언트 없이 직접 업로드(테스트용): chunk hash 계산 → intent → PUT → complete 반복 */
export async function upload(h: Harness, token: string, projectId: string, kind: 'asset' | 'snapshot', bytes: Uint8Array, opts: { declaredHash?: string; chunkHashes?: string[]; skip?: number[]; complete?: boolean } = {}) {
  const cb = 64 * 1024;
  const chunks: Uint8Array[] = []; for (let o = 0; o < bytes.length; o += cb) chunks.push(bytes.subarray(o, o + cb));
  const r = await h.raw('POST', `/v1/projects/${projectId}/uploads`, token, { kind, hash: opts.declaredHash ?? sha(bytes), bytes: bytes.length, chunkBytes: cb, chunkHashes: opts.chunkHashes ?? chunks.map(sha) });
  const intent = await r.json() as { state: string; uploadId: string; chunks: { n: number; url: string }[] };
  if (r.status >= 300) return { status: r.status, body: intent as unknown as Record<string, unknown> };
  if (intent.state === 'ready') return { status: r.status, body: intent as unknown as Record<string, unknown> };
  for (const c of intent.chunks) {
    if (opts.skip?.includes(c.n)) continue;
    const pr = await h.fetch(c.url, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: chunks[c.n] as unknown as BodyInit });
    if (pr.status !== 200) return { status: pr.status, body: await pr.json() as Record<string, unknown>, uploadId: intent.uploadId };
  }
  if (opts.complete === false) return { status: 200, body: intent as unknown as Record<string, unknown>, uploadId: intent.uploadId };
  for (;;) {
    const c = await h.raw('POST', `/v1/projects/${projectId}/uploads/${intent.uploadId}/complete`, token, {});
    const b = await c.json() as Record<string, unknown>;
    if (c.status !== 202) return { status: c.status, body: b, uploadId: intent.uploadId };
  }
}
