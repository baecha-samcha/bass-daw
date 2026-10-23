// 런타임 무관 계약 테스트: HTTP 와 bucket 조작(테스트용)만 사용한다.
// 같은 스위트를 (a) Node 대체 환경(node:sqlite D1 + 로컬 R2)과 (b) 실제 workerd(Miniflare D1/R2)에서 실행한다.
// 결과는 환경별로 따로 보고한다 — Node 통과를 workerd/실서비스 통과로 간주하지 않는다.
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createEmptyProject, serializeProject } from '@bass-daw/schemas';

export interface Backend {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  base: string;
  /** R2 직접 조작(테스트 전용): 서버 밖에서 객체가 바뀌는 상황 */
  keys(): Promise<string[]>;
  overwrite(key: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export type MakeBackend = (vars: Record<string, string>) => Promise<Backend>;

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const bytesOf = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 29 + seed * 3) & 255);
const CB = 65536;

function client(b: Backend) {
  const call = async (method: string, path: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await b.fetch(path.startsWith('http') ? path : `${b.base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...extra }, body: body === undefined ? undefined : body instanceof Uint8Array ? body as unknown as BodyInit : JSON.stringify(body) });
    const text = await r.text();
    let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: r.status, body: json, raw: text };
  };
  const login = async (user: string) => (await call('POST', '/v1/dev/login', null, { user })).body.token as string;
  const intent = (t: string, pid: string, kind: string, bytes: Uint8Array, declared = sha(bytes)) => {
    const ch: string[] = []; for (let o = 0; o < bytes.length; o += CB) ch.push(sha(bytes.subarray(o, o + CB)));
    return call('POST', `/v1/projects/${pid}/uploads`, t, { kind, hash: declared, bytes: bytes.length, chunkBytes: CB, chunkHashes: ch });
  };
  const putAll = async (t: string, chunks: { n: number; url: string }[], bytes: Uint8Array) => { for (const c of chunks) { const r = await call('PUT', c.url, t, bytes.subarray(c.n * CB, (c.n + 1) * CB)); if (r.status !== 200) return r; } return null; };
  const complete = async (t: string, pid: string, id: string) => { for (;;) { const r = await call('POST', `/v1/projects/${pid}/uploads/${id}/complete`, t, {}); if (r.status !== 202) return r; } };
  const upload = async (t: string, pid: string, kind: string, bytes: Uint8Array, declared?: string) => {
    const i = await intent(t, pid, kind, bytes, declared);
    if (i.body.state === 'ready') return i;
    const bad = await putAll(t, i.body.chunks as { n: number; url: string }[], bytes); if (bad) return bad;
    return complete(t, pid, i.body.uploadId as string);
  };
  return { call, login, intent, putAll, complete, upload };
}

/** 02 형식 snapshot(실제 factory 로 생성 — 서버가 deserialize 검증한다) */
function snapshotBytes(id: string, title: string, assets: Uint8Array[] = []): Uint8Array {
  const p = createEmptyProject({ id, title, now: '2026-10-22T00:00:00.000Z' });
  assets.forEach((b, i) => p.assets.push({ id: `as-${i}`, sha256: sha(b), byteLength: b.length, mediaType: 'audio/wav', audio: null, license: { name: 'self-recorded', origin: 'user', redistribution: 'allowed' } }));
  const s = serializeProject(p); if (!s.ok) throw new Error(JSON.stringify(s.errors)); return s.value;
}

export function contractSuite(make: MakeBackend) {
  const PID = 'proj-1';
  const rev = (id: string, snap: Uint8Array, assets: Uint8Array[], parent: string | null) => ({ id, projectId: PID, parentIds: parent ? [parent] : [], snapshotHash: sha(snap), assetHashes: [...new Set(assets.map(sha))].sort(), editSequence: 1, createdAt: '2026-10-23T00:00:00.000Z' });
  const push = async (c: ReturnType<typeof client>, t: string, title: string, assets: Uint8Array[], id: string, expected: string | null, key = `k-${id}`) => {
    const snap = snapshotBytes(PID, title, assets);
    for (const a of assets) expect((await c.upload(t, PID, 'asset', a)).status).toBe(200);
    expect((await c.upload(t, PID, 'snapshot', snap)).status).toBe(200);
    return c.call('POST', `/v1/projects/${PID}/commits`, t, { projectId: PID, revision: rev(id, snap, assets, expected), expectedRemoteHead: expected, idempotencyKey: key });
  };

  it('fake auth is refused outside development (production defense)', async () => {
    const b = await make({ ENVIRONMENT: 'production' });
    try {
      const c = client(b);
      for (const [m, p] of [['GET', '/v1/health'], ['POST', '/v1/dev/login'], ['GET', '/v1/projects']]) {
        const r = await c.call(m, p, null, m === 'POST' ? { user: 'a' } : undefined);
        expect(r.status).toBe(500); expect(r.body.error).toBe('CONFIG_REFUSED');
      }
    } finally { await b.close(); }
  });

  it('C04: signed URLs are bound to the session owner — a different logged-in user or no session cannot use them', async () => {
    const b = await make({});
    try {
      const c = client(b);
      const A = await c.login('alice'), B = await c.login('bob');
      const asset = bytesOf(100_000, 1);
      expect((await push(c, A, 'a', [asset], 'r1', null)).body.status).toBe('committed');
      const rv = (await c.call('GET', `/v1/projects/${PID}/revisions/r1`, A)).body as { urls: { snapshot: string; assets: Record<string, string> } };
      const dl = Object.values(rv.urls.assets)[0];
      expect((await c.call('GET', dl, A)).status).toBe(200);
      expect((await c.call('GET', dl, B)).status).toBe(403);
      expect((await c.call('GET', dl, null)).status).toBe(401);
      const pend = await c.intent(A, PID, 'asset', bytesOf(70_000, 2));
      const url = (pend.body.chunks as { url: string }[])[0].url;
      expect((await c.call('PUT', url, B, bytesOf(70_000, 2).subarray(0, CB))).status).toBe(403);
      expect((await c.call('PUT', url, null, bytesOf(70_000, 2).subarray(0, CB))).status).toBe(401);
      for (const [m, p] of [['GET', `/v1/projects/${PID}/head`], ['GET', `/v1/projects/${PID}/revisions/r1`], ['GET', `/v1/projects/${PID}/uploads/${pend.body.uploadId}`], ['DELETE', `/v1/projects/${PID}`]]) {
        expect([403, 404]).toContain((await c.call(m, p, B, m === 'DELETE' ? { expectedRemoteHead: 'r1', idempotencyKey: 'x' } : undefined)).status);
      }
      // 서명 토큰 변조 → 403
      expect((await c.call('GET', dl.slice(0, -3) + 'AAA', A)).status).toBe(403);
    } finally { await b.close(); }
  });

  it('C05: client hash lie and mismatched asset lists never become ready/committed', async () => {
    const b = await make({});
    try {
      const c = client(b);
      const A = await c.login('alice');
      const good = bytesOf(150_000, 3), evil = bytesOf(150_000, 4);
      const lie = await c.upload(A, PID, 'asset', evil, sha(good));
      expect(lie.status).toBe(422);
      const snap = snapshotBytes(PID, 's', [good]);
      expect((await c.upload(A, PID, 'snapshot', snap)).status).toBe(200);
      const r = await c.call('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: rev('r1', snap, [good], null), expectedRemoteHead: null, idempotencyKey: 'k1' });
      expect(r.status).toBe(422); expect(r.body.error).toBe('REF_NOT_READY');
      expect((await c.upload(A, PID, 'asset', good)).status).toBe(200);
      const extra = bytesOf(100, 5); expect((await c.upload(A, PID, 'asset', extra)).status).toBe(200);
      const mm = await c.call('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: { ...rev('r1', snap, [good], null), assetHashes: [sha(good), sha(extra)].sort() }, expectedRemoteHead: null, idempotencyKey: 'k2' });
      expect(mm.body.error).toBe('REVISION_MISMATCH');
    } finally { await b.close(); }
  });

  it('object version pinning: an object changed during verification is rejected; a ready object changed later is never served', async () => {
    const b = await make({ VERIFY_BUDGET_BYTES: String(CB) });
    try {
      const c = client(b);
      const A = await c.login('alice');
      const data = bytesOf(4 * CB, 6);
      const i = await c.intent(A, PID, 'asset', data);
      expect(await c.putAll(A, i.body.chunks as { n: number; url: string }[], data)).toBeNull();
      const first = await c.call('POST', `/v1/projects/${PID}/uploads/${i.body.uploadId}/complete`, A, {});
      expect(first.status).toBe(202);
      const key = (await b.keys()).find((k) => k.includes(`/${sha(data)}/`))!;
      const other = new Uint8Array(data); other[3 * CB + 5] ^= 0xff; // 검증이 아직 읽지 않은 구간만 다른 새 버전
      await b.overwrite(key, other);
      const end = await c.complete(A, PID, i.body.uploadId as string);
      expect(end.status).toBe(422); expect(['OBJECT_CHANGED', 'HASH_MISMATCH']).toContain(end.body.error);
      // 다시 정상 업로드 → ready → commit → 이후 R2 객체를 바꾸면 다운로드 거절
      expect((await c.upload(A, PID, 'asset', data)).status).toBe(200);
      expect((await push(c, A, 'pin', [data], 'r1', null)).body.status).toBe('committed');
      const rv = (await c.call('GET', `/v1/projects/${PID}/revisions/r1`, A)).body as { urls: { assets: Record<string, string> } };
      const url = rv.urls.assets[sha(data)];
      const ok = await b.fetch(url, { headers: { authorization: `Bearer ${A}` } });
      expect(sha(new Uint8Array(await ok.arrayBuffer()))).toBe(sha(data));
      const readyKey = (await b.keys()).find((k) => k.includes(`/${sha(data)}/`))!;
      const tampered = new Uint8Array(data); tampered[7] ^= 1;
      await b.overwrite(readyKey, tampered);
      const after = await c.call('GET', url, A);
      expect(after.status).toBe(409); expect(after.body.error).toBe('OBJECT_CHANGED');
    } finally { await b.close(); }
  });

  it('two uploads of the same hash use distinct keys; one cannot overwrite the other', async () => {
    const b = await make({});
    try {
      const c = client(b);
      const A = await c.login('alice');
      const data = bytesOf(2 * CB, 7);
      const i1 = await c.intent(A, PID, 'asset', data);
      // 같은 hash 에 다른 chunk 목록을 주장하는 두 번째 intent → 첫 업로드는 rejected, 서로 다른 key
      const i2 = await c.call('POST', `/v1/projects/${PID}/uploads`, A, { kind: 'asset', hash: sha(data), bytes: data.length, chunkBytes: CB, chunkHashes: [sha(data.subarray(0, CB)), 'f'.repeat(64)] });
      expect(i2.body.uploadId).not.toBe(i1.body.uploadId);
      const ok = await c.upload(A, PID, 'asset', data);
      expect(ok.status).toBe(200);
      const keys = (await b.keys()).filter((k) => k.includes(`/${sha(data)}/`));
      expect(keys.length).toBe(1);
    } finally { await b.close(); }
  });

  it('CAS: concurrent commits on the same base → exactly one committed, one retained conflict (10 rounds)', async () => {
    const b = await make({});
    try {
      const c = client(b);
      const A = await c.login('alice');
      expect((await push(c, A, 'base', [], 'base', null)).body.status).toBe('committed');
      let parent = 'base';
      for (let i = 0; i < 10; i++) {
        const s1 = snapshotBytes(PID, `x${i}`), s2 = snapshotBytes(PID, `y${i}`);
        await c.upload(A, PID, 'snapshot', s1); await c.upload(A, PID, 'snapshot', s2);
        const [r1, r2] = await Promise.all([
          c.call('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: rev(`x${i}`, s1, [], parent), expectedRemoteHead: parent, idempotencyKey: `kx${i}` }),
          c.call('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: rev(`y${i}`, s2, [], parent), expectedRemoteHead: parent, idempotencyKey: `ky${i}` }),
        ]);
        const st = [r1.body.status, r2.body.status].sort();
        expect(st).toEqual(['committed', 'conflict']);
        parent = (r1.body.status === 'committed' ? r1 : r2).body.remoteHead as string;
        expect((await c.call('GET', `/v1/projects/${PID}/head`, A)).body.head).toBe(parent);
      }
      // idempotency: 같은 key 재전송 = 같은 결과, 다른 payload = 409
      const s = snapshotBytes(PID, 'idem'); await c.upload(A, PID, 'snapshot', s);
      const body = { projectId: PID, revision: rev('idem', s, [], parent), expectedRemoteHead: parent, idempotencyKey: 'ki' };
      const one = await c.call('POST', `/v1/projects/${PID}/commits`, A, body);
      expect(await c.call('POST', `/v1/projects/${PID}/commits`, A, body).then((r) => r.body)).toEqual(one.body);
      expect((await c.call('POST', `/v1/projects/${PID}/commits`, A, { ...body, revision: { ...body.revision, editSequence: 5 } })).status).toBe(409);
    } finally { await b.close(); }
  });

  it('tombstone delete (stale → 409) and restore via CAS', async () => {
    const b = await make({});
    try {
      const c = client(b);
      const A = await c.login('alice');
      await push(c, A, 'v1', [], 'v1', null);
      await push(c, A, 'v2', [], 'v2', 'v1');
      expect((await c.call('DELETE', `/v1/projects/${PID}`, A, { expectedRemoteHead: 'v1', idempotencyKey: 'd0' })).status).toBe(409);
      const d = await c.call('DELETE', `/v1/projects/${PID}`, A, { expectedRemoteHead: 'v2', idempotencyKey: 'd1' });
      expect(d.status).toBe(200);
      expect((await c.call('GET', `/v1/projects/${PID}/head`, A)).body.tombstoned).toBe(true);
      const r = await c.call('POST', `/v1/projects/${PID}/restore`, A, { expectedRemoteHead: d.body.remoteHead, revisionId: 'v2', idempotencyKey: 'r1' });
      expect(r.body.status).toBe('committed');
      expect((await c.call('GET', `/v1/projects/${PID}/head`, A)).body.tombstoned).toBe(false);
    } finally { await b.close(); }
  });
}
