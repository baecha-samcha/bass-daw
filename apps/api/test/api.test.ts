// MVP-7 API 통합 테스트(로컬 D1=node:sqlite, R2=메모리 어댑터, fake auth). 실제 Cloudflare·공급자 통합은 BLOCKED(D07/D08).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { setup, upload, snapshotOf, sha, type Harness } from './helpers.ts';
import { handle } from '../src/app.ts';
import { localEnv } from '../local/env.ts';
import { f00 } from '../../../tests/fixtures/projects.ts';
import { fid } from '../../../tests/fixtures/ids.ts';
import type { Project } from '@bass-daw/schemas';

const PID = fid(1);
const bytesOf = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7) & 255);
function projectWith(assets: Uint8Array[], title = 'F00'): Project {
  const p = structuredClone(f00()); p.title = title;
  assets.forEach((b, i) => p.assets.push({ id: fid(40 + i), sha256: sha(b), byteLength: b.length, mediaType: 'audio/wav', audio: null, license: { name: 'self-recorded', origin: 'user', redistribution: 'allowed' } }));
  return p;
}
const revOf = (id: string, snap: Uint8Array, p: Project, parent: string | null = null) => ({ id, projectId: p.id, parentIds: parent ? [parent] : [], snapshotHash: sha(snap), assetHashes: [...new Set(p.assets.map((a) => a.sha256))].sort(), editSequence: 1, createdAt: '2026-10-23T00:00:00.000Z' });

async function pushRevision(h: Harness, token: string, p: Project, revId: string, expected: string | null, key = `k-${revId}`) {
  for (const a of p.assets) void a;
  const snap = snapshotOf(p);
  const s = await upload(h, token, p.id, 'snapshot', snap); expect(s.status).toBe(200);
  return h.raw('POST', `/v1/projects/${p.id}/commits`, token, { projectId: p.id, revision: revOf(revId, snap, p, expected), expectedRemoteHead: expected, idempotencyKey: key });
}

describe('fake auth is development-only (production defense)', () => {
  const req = (url: string, init?: RequestInit) => new Request(url, init);
  it('refuses every request when fake auth is configured outside development or localhost or with a placeholder secret', async () => {
    for (const vars of [{ ENVIRONMENT: 'production' }, { ENVIRONMENT: undefined }, { ENVIRONMENT: 'staging' }, { FAKE_AUTH_SECRET: 'replace-with-random-local-secret' }, { FAKE_AUTH_SECRET: 'short' }]) {
      const env = localEnv({ vars: vars as never });
      for (const path of ['/v1/health', '/v1/dev/login', '/v1/projects']) {
        const r = await handle(req(`http://localhost${path}`, { method: path.includes('login') ? 'POST' : 'GET', body: path.includes('login') ? '{"user":"a"}' : undefined }), env);
        expect(r.status).toBe(500);
        expect((await r.json()).error).toBe('CONFIG_REFUSED');
      }
    }
    const env = localEnv();
    const r = await handle(req('https://api.example.com/v1/dev/login', { method: 'POST', body: '{"user":"a"}' }), env);
    expect((await r.json()).error).toBe('CONFIG_REFUSED'); // localhost 가 아니면 fake 거절
  });
  it('AUTH_MODE=none (deploy default): no login route, authed routes report AUTH_NOT_CONFIGURED', async () => {
    const env = localEnv({ vars: { AUTH_MODE: 'none', ENVIRONMENT: 'production', FAKE_AUTH_SECRET: undefined } });
    expect((await handle(req('https://api.example.com/v1/dev/login', { method: 'POST', body: '{"user":"a"}' }), env)).status).toBe(404);
    const r = await handle(req('https://api.example.com/v1/projects', { headers: { authorization: 'Bearer fake1.x.y' } }), env);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('AUTH_NOT_CONFIGURED');
  });
  it('a token signed for one dev server is not accepted by another (per-run random secret); forged/expired tokens are 401', async () => {
    const a = setup(); const b = setup();
    const t = (await a.login('alice')).token;
    expect((await b.raw('GET', '/v1/projects', t)).status).toBe(401);
    expect((await a.raw('GET', '/v1/projects', t.slice(0, -2) + 'xx')).status).toBe(401);
    const short = (await a.login('alice', 1)).token;
    a.tick(2000);
    const r = await a.raw('GET', '/v1/projects', short);
    expect(r.status).toBe(401); expect((await r.json()).error).toBe('AUTH_REQUIRED');
  });
  it('shipped wrangler.toml defaults to AUTH_MODE="none"/ENVIRONMENT="production"; fake values live only in the gitignored .dev.vars', () => {
    const toml = readFileSync('apps/api/wrangler.toml', 'utf8');
    expect(toml).toMatch(/AUTH_MODE\s*=\s*"none"/);
    expect(toml).toMatch(/ENVIRONMENT\s*=\s*"production"/);
    expect(toml.replace(/#.*$/gm, '')).not.toMatch(/"fake"|FAKE_AUTH_SECRET|"development"/);
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/\.dev\.vars/);
    const ex = readFileSync('apps/api/.dev.vars.example', 'utf8');
    expect(ex).toMatch(/FAKE_AUTH_SECRET=replace-with-random-local-secret/); // placeholder 만
  });
});

describe('CORS / origin allowlist', () => {
  it('disallowed origin refused, allowed origin gets CORS headers, preflight ok', async () => {
    const h = setup();
    const bad = await h.raw('GET', '/v1/health', null, undefined, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    const ok = await h.raw('GET', '/v1/health', null, undefined, { origin: 'http://localhost:4173' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
    const pre = await h.raw('OPTIONS', '/v1/projects', null, undefined, { origin: 'http://localhost:4173', 'access-control-request-method': 'POST' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
  });
});

describe('C04: another account cannot read or write any project/upload/revision/object (403 or non-disclosing 404)', () => {
  it('every endpoint', async () => {
    const h = setup();
    const A = (await h.login('alice')).token, B = (await h.login('bob')).token;
    const asset = bytesOf(150_000, 1);
    const p = projectWith([asset]);
    expect((await upload(h, A, PID, 'asset', asset)).status).toBe(200);
    const c = await pushRevision(h, A, p, 'rev-a1', null);
    expect((await c.json()).status).toBe('committed');
    // A 의 미완료 업로드와 읽기 URL
    const pending = await upload(h, A, PID, 'asset', bytesOf(70_000, 2), { complete: false, skip: [1] });
    const rv = await (await h.raw('GET', `/v1/projects/${PID}/revisions/rev-a1`, A)).json() as { urls: { snapshot: string; assets: Record<string, string> } };
    const intentA = await (await h.raw('POST', `/v1/projects/${PID}/uploads`, A, { kind: 'asset', hash: sha(bytesOf(70_000, 3)), bytes: 70_000, chunkBytes: 65536, chunkHashes: [sha(bytesOf(70_000, 3).subarray(0, 65536)), sha(bytesOf(70_000, 3).subarray(65536))] })).json() as { chunks: { url: string }[] };
    const before = await (await h.raw('GET', `/v1/projects/${PID}/head`, A)).json();
    const checks: [string, string, unknown?][] = [
      ['GET', `/v1/projects/${PID}/head`], ['GET', `/v1/projects/${PID}/revisions/rev-a1`], ['GET', `/v1/projects/${PID}/branches`],
      ['GET', `/v1/projects/${PID}/uploads/${pending.uploadId}`], ['POST', `/v1/projects/${PID}/uploads/${pending.uploadId}/complete`, {}],
      ['POST', `/v1/projects/${PID}/branches`, { revision: { id: 'x', projectId: PID, parentIds: [], snapshotHash: 'a'.repeat(64), assetHashes: [], editSequence: 1, createdAt: 'x' }, idempotencyKey: 'kb' }],
      ['DELETE', `/v1/projects/${PID}`, { expectedRemoteHead: 'rev-a1', idempotencyKey: 'kd' }],
      ['POST', `/v1/projects/${PID}/restore`, { expectedRemoteHead: 'rev-a1', revisionId: 'rev-a1', idempotencyKey: 'kr' }],
    ];
    for (const [m, path, body] of checks) {
      const r = await h.raw(m, path, B, body);
      expect([403, 404], `${m} ${path}`).toContain(r.status);
    }
    // 서명 URL 을 탈취해도 다른 계정 세션으로는 사용 불가
    for (const url of [rv.urls.snapshot, Object.values(rv.urls.assets)[0]]) expect((await h.fetch(url, { headers: { authorization: `Bearer ${B}` } })).status).toBe(403);
    expect((await h.fetch(intentA.chunks[0].url, { method: 'PUT', headers: { authorization: `Bearer ${B}` }, body: bytesOf(70_000, 3).subarray(0, 65536) as unknown as BodyInit })).status).toBe(403);
    // 세션 없이도 불가
    expect((await h.fetch(rv.urls.snapshot)).status).toBe(401);
    // B 의 같은 id commit 은 B 의 별도 namespace 에 들어가며 A 에 영향 없음
    const pb = projectWith([], 'Bob');
    expect((await (await pushRevision(h, B, pb, 'rev-b1', null)).json()).status).toBe('committed');
    expect((await (await h.raw('GET', '/v1/projects', B)).json()).projects.map((x: { id: string; head: string }) => x.head)).toEqual(['rev-b1']);
    expect(await (await h.raw('GET', `/v1/projects/${PID}/head`, A)).json()).toEqual(before);
    // B 는 A 의 asset 을 참조하는 commit 을 만들 수 없다(존재 여부도 알 수 없음)
    const steal = projectWith([asset], 'Steal');
    const sc = await pushRevision(h, B, steal, 'rev-b2', 'rev-b1');
    expect(sc.status).toBe(422); expect((await sc.json()).error).toBe('REF_NOT_READY');
  });
});

describe('C05: commits may only reference server-verified ready objects', () => {
  it('missing / incomplete / client-hash-lie / tampered-in-R2 / mismatched asset list are all refused', async () => {
    const h = setup({ VERIFY_BUDGET_BYTES: String(64 * 1024) });
    const A = (await h.login('alice')).token;
    const good = bytesOf(200_000, 5);
    const p = projectWith([good]);
    const snap = snapshotOf(p);
    // (a) 아무것도 업로드하지 않음
    let r = await h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'k1' });
    expect(r.status).toBe(422); expect((await r.json()).missing.length).toBe(2);
    // (b) 미완료 업로드(chunk 누락) → complete 거절, commit 거절
    const inc = await upload(h, A, PID, 'asset', good, { skip: [2] });
    expect(inc.status).toBe(409); expect(inc.body.error).toBe('UPLOAD_INCOMPLETE');
    expect(await upload(h, A, PID, 'snapshot', snap).then((x) => x.status)).toBe(200);
    r = await h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'k2' });
    expect((await r.json()).error).toBe('REF_NOT_READY');
    // (c) 클라이언트가 다른 바이트에 대해 hash H 를 주장(chunk hash 는 실제 바이트와 일치) → 서버 전체 SHA-256 불일치로 rejected
    const evil = bytesOf(130_000, 9);
    const chunks = [evil.subarray(0, 65536), evil.subarray(65536)].map(sha);
    const lie = await upload(h, A, PID, 'asset', evil, { declaredHash: sha(good), chunkHashes: [...chunks, sha(new Uint8Array(0))].slice(0, 2) });
    expect(lie.status).toBe(422); expect(lie.body.error).toBe('HASH_MISMATCH'); // chunk 는 맞아도 서버 전체 hash 가 다름
    const lie2Bytes = bytesOf(200_000, 11); // good 과 같은 길이의 다른 바이트
    const lie2 = await upload(h, A, PID, 'asset', lie2Bytes, { declaredHash: sha(good) });
    expect(lie2.status).toBe(422); expect(lie2.body.error).toBe('HASH_MISMATCH');
    r = await h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'k3' });
    expect((await r.json()).error).toBe('REF_NOT_READY');
    // (d) chunk 바이트 변조 → chunk 단위 422
    const intent = await (await h.raw('POST', `/v1/projects/${PID}/uploads`, A, { kind: 'asset', hash: sha(good), bytes: good.length, chunkBytes: 65536, chunkHashes: [0, 1, 2, 3].map((n) => sha(good.subarray(n * 65536, (n + 1) * 65536))) })).json() as { uploadId: string; chunks: { n: number; url: string }[] };
    const bad = new Uint8Array(good.subarray(0, 65536)); bad[10] ^= 1;
    const pr = await h.fetch(intent.chunks[0].url, { method: 'PUT', headers: { authorization: `Bearer ${A}` }, body: bad as unknown as BodyInit });
    expect(pr.status).toBe(422);
    // (e) chunk 는 정상인데 complete 후 검증 job 도중 R2 객체가 바뀜 → 서버 hash 불일치
    for (const c of intent.chunks) await h.fetch(c.url, { method: 'PUT', headers: { authorization: `Bearer ${A}` }, body: good.subarray(c.n * 65536, (c.n + 1) * 65536) as unknown as BodyInit });
    const c1 = await h.raw('POST', `/v1/projects/${PID}/uploads/${intent.uploadId}/complete`, A, {});
    expect(c1.status).toBe(202); // bounded: 64KiB 만 검증하고 상태 저장
    const key = h.env.BUCKET.keys().find((k) => k.includes(`/${sha(good)}/`))!;
    h.env.BUCKET.tamper(key, (b) => { b[150_000] ^= 0xff; return b; });
    let last: Response;
    do { last = await h.raw('POST', `/v1/projects/${PID}/uploads/${intent.uploadId}/complete`, A, {}); } while (last.status === 202);
    expect(last.status).toBe(422);
    expect(h.env.BUCKET.keys().some((k) => k.includes(`/${sha(good)}/`))).toBe(false); // 미검증 객체 제거
    // 정상 업로드 후에는 commit 가능. (f) assetHashes 가 snapshot 참조와 다르면 거절
    expect((await upload(h, A, PID, 'asset', good)).status).toBe(200);
    const extra = bytesOf(1000, 3); expect((await upload(h, A, PID, 'asset', extra)).status).toBe(200);
    r = await h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: { ...revOf('r1', snap, p), assetHashes: [sha(good), sha(extra)].sort() }, expectedRemoteHead: null, idempotencyKey: 'k4' });
    expect((await r.json()).error).toBe('REVISION_MISMATCH');
    r = await h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'k5' });
    expect(await r.json()).toEqual({ status: 'committed', remoteHead: 'r1' });
  });
  it('a snapshot that is not a valid project, or belongs to another project id, never becomes ready', async () => {
    const h = setup();
    const A = (await h.login('alice')).token;
    const junk = new TextEncoder().encode('{"not":"a project"}');
    expect((await upload(h, A, PID, 'snapshot', junk)).body.error).toBe('REVISION_MISMATCH');
    const other = projectWith([]); other.id = fid(99);
    expect((await upload(h, A, PID, 'snapshot', snapshotOf(other))).body.error).toBe('REVISION_MISMATCH');
  });
});

describe('uploads: bounded incremental verification, resume, URL expiry, quota', () => {
  it('large object is verified across several bounded calls with persisted SHA-256 state', async () => {
    const h = setup({ VERIFY_BUDGET_BYTES: String(64 * 1024) });
    const A = (await h.login('alice')).token;
    const big = bytesOf(5 * 65536 + 123, 4);
    const intent = await (await h.raw('POST', `/v1/projects/${PID}/uploads`, A, { kind: 'asset', hash: sha(big), bytes: big.length, chunkBytes: 65536, chunkHashes: Array.from({ length: 6 }, (_, n) => sha(big.subarray(n * 65536, (n + 1) * 65536))) })).json() as { uploadId: string; chunks: { n: number; url: string }[] };
    for (const c of intent.chunks) await h.fetch(c.url, { method: 'PUT', headers: { authorization: `Bearer ${A}` }, body: big.subarray(c.n * 65536, (c.n + 1) * 65536) as unknown as BodyInit });
    const progress: number[] = [];
    for (;;) {
      const r = await h.raw('POST', `/v1/projects/${PID}/uploads/${intent.uploadId}/complete`, A, {});
      const b = await r.json();
      if (r.status === 200) { expect(b.state).toBe('ready'); break; }
      expect(r.status).toBe(202); progress.push(b.verifiedBytes);
      const row = h.env.DB.raw.prepare('SELECT verify_state FROM uploads WHERE upload_id = ?').get(intent.uploadId) as { verify_state: string };
      expect(JSON.parse(row.verify_state).offset).toBe(b.verifiedBytes); // 재개 가능한 상태가 D1 에 저장됨
    }
    expect(progress).toEqual([65536, 131072, 196608, 262144, 327680]);
  });
  it('resume: a new intent for the same object returns only the missing chunks; expired chunk URLs are refreshed', async () => {
    const h = setup({ URL_TTL_SEC: '60' });
    const A = (await h.login('alice', 3600)).token;
    const big = bytesOf(3 * 65536, 6);
    const first = await upload(h, A, PID, 'asset', big, { skip: [1, 2], complete: false });
    const again = await (await h.raw('POST', `/v1/projects/${PID}/uploads`, A, { kind: 'asset', hash: sha(big), bytes: big.length, chunkBytes: 65536, chunkHashes: [0, 1, 2].map((n) => sha(big.subarray(n * 65536, (n + 1) * 65536))) })).json() as { uploadId: string; chunks: { n: number; url: string }[] };
    expect(again.uploadId).toBe(first.uploadId);
    expect(again.chunks.map((c) => c.n)).toEqual([1, 2]);
    h.tick(61_000);
    const exp = await h.fetch(again.chunks[0].url, { method: 'PUT', headers: { authorization: `Bearer ${A}` }, body: big.subarray(65536, 131072) as unknown as BodyInit });
    expect(exp.status).toBe(403); expect((await exp.json()).error).toBe('UPLOAD_EXPIRED');
    const st = await (await h.raw('GET', `/v1/projects/${PID}/uploads/${again.uploadId}`, A)).json() as { received: number[]; chunks: { n: number; url: string }[] };
    expect(st.received).toEqual([0]);
    for (const c of st.chunks) expect((await h.fetch(c.url, { method: 'PUT', headers: { authorization: `Bearer ${A}` }, body: big.subarray(c.n * 65536, (c.n + 1) * 65536) as unknown as BodyInit })).status).toBe(200);
    const done = await h.raw('POST', `/v1/projects/${PID}/uploads/${again.uploadId}/complete`, A, {});
    expect((await done.json()).state).toBe('ready');
  });
  it('quota and size limits are enforced per account', async () => {
    const h = setup({ QUOTA_BYTES: String(150_000), MAX_ASSET_BYTES: String(120_000) });
    const A = (await h.login('alice')).token;
    expect((await upload(h, A, PID, 'asset', bytesOf(130_000, 1))).status).toBe(413);
    expect((await upload(h, A, PID, 'asset', bytesOf(100_000, 1))).status).toBe(200);
    const q = await upload(h, A, PID, 'asset', bytesOf(100_000, 2));
    expect(q.status).toBe(413); expect(q.body.error).toBe('QUOTA');
    const B = (await h.login('bob')).token;
    expect((await upload(h, B, PID, 'asset', bytesOf(100_000, 2))).status).toBe(200); // 다른 계정 quota 는 별개
  });
  it('rate limit: 429 with Retry-After', async () => {
    const h = setup({ RATE_LIMIT_PER_MIN: '5' });
    const A = (await h.login('alice')).token;
    for (let i = 0; i < 5; i++) expect((await h.raw('GET', '/v1/projects', A)).status).toBe(200);
    const r = await h.raw('GET', '/v1/projects', A);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('head CAS, idempotency, SQL failure vs CAS failure', () => {
  it('two writers with the same base race: exactly one head wins, the other is a retained conflict branch (20 rounds)', async () => {
    for (let round = 0; round < 20; round++) {
      let armed = false; let arrived = 0; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      // 두 요청이 모두 사전 검사를 통과해 CAS 직전에 도달한 뒤 동시에 진행하도록 막는다
      const h = setup({ __beforeCas: async () => { if (!armed) return; if (++arrived === 2) release(); await gate; } });
      const A = (await h.login('alice')).token;
      const base = await pushRevision(h, A, projectWith([], 'base'), 'base', null);
      expect((await base.json()).status).toBe('committed');
      armed = true;
      const p1 = projectWith([], 'one'), p2 = projectWith([], 'two');
      const s1 = snapshotOf(p1), s2 = snapshotOf(p2);
      await upload(h, A, PID, 'snapshot', s1); await upload(h, A, PID, 'snapshot', s2);
      const [r1, r2] = await Promise.all([
        h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('one', s1, p1, 'base'), expectedRemoteHead: 'base', idempotencyKey: 'k-one' }).then((r) => r.json()),
        h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('two', s2, p2, 'base'), expectedRemoteHead: 'base', idempotencyKey: 'k-two' }).then((r) => r.json()),
      ]);
      const res = [r1, r2];
      expect(res.filter((x) => x.status === 'committed').length).toBe(1);
      const loser = res.find((x) => x.status === 'conflict')!;
      const winner = res.find((x) => x.status === 'committed')!;
      expect(loser.remoteHead).toBe(winner.remoteHead);
      const head = await (await h.raw('GET', `/v1/projects/${PID}/head`, A)).json();
      expect(head.head).toBe(winner.remoteHead);
      const br = await (await h.raw('GET', `/v1/projects/${PID}/branches`, A)).json();
      expect(br.branches.map((b: { revision_id: string; reason: string }) => `${b.revision_id}:${b.reason}`)).toEqual([`${loser.retainedRevision}:conflict`]);
      // 진 쪽 revision 도 서버에 보존(내용 조회 가능)
      expect((await h.raw('GET', `/v1/projects/${PID}/revisions/${loser.retainedRevision}`, A)).status).toBe(200);
    }
  });
  it('same key + same payload → identical stored result even after head moved; same key + different payload → 409', async () => {
    const h = setup();
    const A = (await h.login('alice')).token;
    const p = projectWith([]); const snap = snapshotOf(p);
    await upload(h, A, PID, 'snapshot', snap);
    const body = { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'same' };
    const first = await (await h.raw('POST', `/v1/projects/${PID}/commits`, A, body)).json();
    expect((await (await pushRevision(h, A, projectWith([], 'later'), 'r2', 'r1')).json()).status).toBe('committed');
    expect(await (await h.raw('POST', `/v1/projects/${PID}/commits`, A, body)).json()).toEqual(first);
    const diff = await h.raw('POST', `/v1/projects/${PID}/commits`, A, { ...body, revision: { ...body.revision, editSequence: 9 } });
    expect(diff.status).toBe(409); expect((await diff.json()).error).toBe('IDEMPOTENCY_MISMATCH');
    const revs = h.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?").get(PID) as { n: number };
    expect(revs.n).toBe(2);
  });
  it('a failed SQL transaction is a retryable 503 with no state change — never reported as a conflict', async () => {
    const h = setup();
    const A = (await h.login('alice')).token;
    const p = projectWith([]); const snap = snapshotOf(p);
    await upload(h, A, PID, 'snapshot', snap);
    const body = { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'tx' };
    h.env.DB.failNextBatch = new Error('D1_ERROR: database is locked');
    const r = await h.raw('POST', `/v1/projects/${PID}/commits`, A, body);
    expect(r.status).toBe(503); expect((await r.json()).error).toBe('DB_ERROR');
    const counts = h.env.DB.raw.prepare("SELECT (SELECT COUNT(*) FROM revisions) AS r, (SELECT COUNT(*) FROM idempotency) AS i, (SELECT COUNT(*) FROM projects) AS p, (SELECT COUNT(*) FROM branches) AS b").get() as Record<string, number>;
    expect(counts).toEqual({ r: 0, i: 0, p: 0, b: 0 });
    expect(await (await h.raw('POST', `/v1/projects/${PID}/commits`, A, body)).json()).toEqual({ status: 'committed', remoteHead: 'r1' });
  });
  it('concurrent retries with the same key return one result and create one revision', async () => {
    const h = setup();
    const A = (await h.login('alice')).token;
    const p = projectWith([]); const snap = snapshotOf(p);
    await upload(h, A, PID, 'snapshot', snap);
    const body = { projectId: PID, revision: revOf('r1', snap, p), expectedRemoteHead: null, idempotencyKey: 'dup' };
    const rs = await Promise.all([1, 2, 3].map(() => h.raw('POST', `/v1/projects/${PID}/commits`, A, body).then((r) => r.json())));
    expect(rs).toEqual([1, 2, 3].map(() => ({ status: 'committed', remoteHead: 'r1' })));
    expect((h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n).toBe(1);
  });
});

describe('tombstone delete / restore (C03 server side)', () => {
  it('stale delete → 409; delete → tombstone (no physical delete); offline commit → conflict(remoteDeleted); restore via CAS', async () => {
    const h = setup();
    const A = (await h.login('alice')).token;
    const asset = bytesOf(90_000, 3);
    await upload(h, A, PID, 'asset', asset);
    await pushRevision(h, A, projectWith([asset], 'v1'), 'v1', null);
    await pushRevision(h, A, projectWith([asset], 'v2'), 'v2', 'v1');
    const stale = await h.raw('DELETE', `/v1/projects/${PID}`, A, { expectedRemoteHead: 'v1', idempotencyKey: 'd0' });
    expect(stale.status).toBe(409); expect((await stale.json()).remoteHead).toBe('v2');
    const del = await h.raw('DELETE', `/v1/projects/${PID}`, A, { expectedRemoteHead: 'v2', idempotencyKey: 'd1' });
    expect(del.status).toBe(200);
    const tomb = (await del.json()).remoteHead;
    const head = await (await h.raw('GET', `/v1/projects/${PID}/head`, A)).json();
    expect(head.tombstoned).toBe(true); expect(head.revision.kind).toBe('tombstone'); expect(head.revision.parentIds).toEqual(['v2']);
    expect(h.env.BUCKET.keys().length).toBe(3); // 자산·snapshot 2개 그대로(물리 삭제 없음)
    // 같은 key 재전송 → 같은 결과
    expect(await (await h.raw('DELETE', `/v1/projects/${PID}`, A, { expectedRemoteHead: 'v2', idempotencyKey: 'd1' })).json()).toEqual({ status: 'deleted', remoteHead: tomb, purgeAfter: head.purgeAfter });
    // 오프라인 편집(기대 head v2) → conflict + remoteDeleted, candidate 보존
    const off = await pushRevision(h, A, projectWith([asset], 'offline'), 'off1', 'v2');
    expect(await off.json()).toEqual({ status: 'conflict', remoteHead: tomb, retainedRevision: 'off1', remoteDeleted: true });
    // 복원: tombstone 위 CAS
    const badRestore = await h.raw('POST', `/v1/projects/${PID}/restore`, A, { expectedRemoteHead: 'v2', revisionId: 'off1', idempotencyKey: 'r0' });
    expect(badRestore.status).toBe(409);
    const rs = await h.raw('POST', `/v1/projects/${PID}/restore`, A, { expectedRemoteHead: tomb, revisionId: 'off1', idempotencyKey: 'r1' });
    const rsb = await rs.json();
    expect(rsb.status).toBe('committed');
    const h2 = await (await h.raw('GET', `/v1/projects/${PID}/head`, A)).json();
    expect(h2.tombstoned).toBe(false); expect(h2.head).toBe(rsb.remoteHead);
    expect(h2.revision.snapshotHash).toBe(sha(snapshotOf(projectWith([asset], 'offline'))));
  });
});

describe('C06 server GC reachability', () => {
  it('keeps every object referenced by normal/branch/tombstone/restore revisions; removes expired uploads and week-old orphans only', async () => {
    const h = setup();
    const A = (await h.login('alice')).token;
    const a1 = bytesOf(70_000, 1), a2 = bytesOf(70_000, 2), orphan = bytesOf(70_000, 3);
    for (const b of [a1, a2, orphan]) await upload(h, A, PID, 'asset', b);
    await pushRevision(h, A, projectWith([a1], 'one'), 'one', null);
    // a2 는 충돌 branch 에서만 참조
    const pb = projectWith([a2], 'branch');
    const sb = snapshotOf(pb); await upload(h, A, PID, 'snapshot', sb);
    expect((await (await h.raw('POST', `/v1/projects/${PID}/commits`, A, { projectId: PID, revision: revOf('br', sb, pb), expectedRemoteHead: null, idempotencyKey: 'kbr' })).json()).status).toBe('conflict');
    await h.raw('DELETE', `/v1/projects/${PID}`, A, { expectedRemoteHead: 'one', idempotencyKey: 'kd' });
    const stuck = await upload(h, A, PID, 'asset', bytesOf(70_000, 7), { complete: false, skip: [1] });
    void stuck;
    const before = h.env.BUCKET.keys();
    h.tick(2 * 86_400_000); // 업로드 intent(24h) 만료, orphan 은 아직 7일 전
    let g = await (await h.raw('POST', '/v1/dev/gc', null)).json();
    expect(g.expiredUploads).toBe(1); expect(g.orphanObjects).toEqual([]);
    expect(h.env.BUCKET.pendingMultipart()).toBe(0);
    h.tick(6 * 86_400_000);
    g = await (await h.raw('POST', '/v1/dev/gc', null)).json();
    expect(g.orphanObjects).toEqual([`asset:${sha(orphan)}`]);
    expect(g.purged).toBe(0); expect(g.purgeEligibleTombstones).toBe(0);
    const after = h.env.BUCKET.keys();
    expect(before.filter((k) => !after.includes(k))).toEqual([before.find((k) => k.includes(`/${sha(orphan)}/`))]);
    h.tick(30 * 86_400_000);
    g = await (await h.raw('POST', '/v1/dev/gc', null)).json();
    expect(g.purgeEligibleTombstones).toBe(1); expect(g.purged).toBe(0); // 물리 삭제는 하지 않음(보고만)
    expect(h.env.BUCKET.keys()).toEqual(after);
  });
});

describe('local D1 migrations (runbook)', () => {
  it('a persisted state directory survives restarts; new migrations apply once; data kept', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { LocalD1 } = await import('../local/d1.ts');
    const dir = mkdtempSync(join(tmpdir(), 'bassdaw-d1-'));
    const a = new LocalD1(`${dir}/d1.sqlite`);
    expect(a.migrate('apps/api/migrations')).toEqual(['0001_init.sql', '0002_object_etag.sql']);
    a.raw.exec("INSERT INTO owners VALUES ('o', 'x')"); a.close();
    const b = new LocalD1(`${dir}/d1.sqlite`);
    expect(b.migrate('apps/api/migrations')).toEqual([]); // 재시작: ALTER TABLE 재실행 없음
    expect(b.raw.prepare('SELECT COUNT(*) AS n FROM owners').get()).toEqual({ n: 1 });
    b.close();
    // 0001 만 적용된 이전 상태 → 0002 만 추가 적용
    const c = new LocalD1(`${dir}/old.sqlite`);
    c.raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)");
    c.raw.exec(readFileSync('apps/api/migrations/0001_init.sql', 'utf8'));
    c.raw.exec("INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_init.sql', 'x')");
    expect(c.migrate('apps/api/migrations')).toEqual(['0002_object_etag.sql']);
    c.close();
  });
});
