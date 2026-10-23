// 2-client 동기화 테스트: 두 "기기"(별도 IndexedDB + ByteStore) 가 같은 로컬 Workers/D1/R2 API 와 SyncEngine 으로 통신한다.
// 기대값은 서버 D1 행·R2 바이트의 독립 hash(node:crypto)와 상태 불변조건으로 확인한다.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { LocalStore, MemoryByteStore, SyncEngine, type SyncFaultStage, type SyncEngineOptions } from '@bass-daw/storage';
import { deserializeProject, type Project } from '@bass-daw/schemas';
import { setup, sha, type Harness } from './helpers.ts';
import { f00 } from '../../../tests/fixtures/projects.ts';
import { fid } from '../../../tests/fixtures/ids.ts';

let dbn = 0;
const bytesOf = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 13 + seed * 5) & 255);

async function device(h: Harness, name: string, opts: SyncEngineOptions = {}) {
  const store = await LocalStore.open(new MemoryByteStore(), `sync-${name}-${process.pid}-${dbn++}`);
  let token: string | null = null;
  const api = h.api(() => token);
  const mk = () => new SyncEngine(store, api, { now: h.now, random: () => 0.5, sleep: async () => {}, autoKick: false, ...opts });
  const d = {
    store, api, engine: mk(),
    owner: null as string | null,
    async login(user: string, ttl?: number) { const l = await h.login(user, ttl); token = l.token; d.owner = l.ownerId; d.engine.setSession({ ownerId: l.ownerId }); },
    logout() { token = null; d.owner = null; d.engine.setSession(null); },
    /** 프로세스 재시작: 새 엔진(메모리 상태 없음), 같은 IDB */
    restart(o: SyncEngineOptions = {}) { d.engine = new SyncEngine(store, api, { now: h.now, random: () => 0.5, sleep: async () => {}, autoKick: false, ...opts, ...o }); if (d.owner) d.engine.setSession({ ownerId: d.owner }); },
    async project(id: string): Promise<Project> { const o = await store.open(id); if (!o.ok) throw new Error(JSON.stringify(o.errors)); return o.value.project; },
    async edit(id: string, f: (p: Project) => void) {
      await store.acquireLease(id);
      const rec = await store.getRecord(id); const p = structuredClone(await d.project(id)); f(p);
      p.updatedAt = new Date(h.now()).toISOString();
      const r = await store.commit(p, rec!.head, (await store.revision(rec!.head!))!.editSequence + 1);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      await store.releaseLease(id);
      return r.value;
    },
  };
  return d;
}

async function newProjectWithAssets(d: Awaited<ReturnType<typeof device>>, assets: Uint8Array[], title = 'Song') {
  const p = structuredClone(f00()); p.title = title;
  for (const [i, b] of assets.entries()) {
    const r = await d.store.importAsset(b); if (!r.ok) throw new Error();
    p.assets.push({ id: fid(40 + i), sha256: r.value.hash, byteLength: b.length, mediaType: 'audio/wav', audio: null, license: { name: 'self-recorded', origin: 'user', redistribution: 'allowed' } });
  }
  await d.store.acquireLease(p.id);
  const c = await d.store.commit(p, null, 0); if (!c.ok) throw new Error(JSON.stringify(c.errors));
  await d.store.releaseLease(p.id);
  return { p, rev: c.value };
}

/** 서버 상태(독립 확인): head, revision 수, R2 의 snapshot 이 로컬 snapshot 과 같은 hash 인지 */
async function server(h: Harness, owner: string, projectId: string) {
  const row = h.env.DB.raw.prepare('SELECT head, tombstoned_at FROM projects WHERE owner_id = ? AND project_id = ?').get(owner, projectId) as { head: string; tombstoned_at: string | null } | undefined;
  const revs = h.env.DB.raw.prepare('SELECT revision_id, kind, snapshot_hash FROM revisions WHERE owner_id = ? AND project_id = ? ORDER BY received_at').all(owner, projectId) as { revision_id: string; kind: string; snapshot_hash: string }[];
  const branches = h.env.DB.raw.prepare('SELECT revision_id, reason FROM branches WHERE owner_id = ? AND project_id = ?').all(owner, projectId) as { revision_id: string; reason: string }[];
  const objects = h.env.DB.raw.prepare("SELECT kind, hash, r2_key FROM objects WHERE owner_id = ? AND project_id = ? AND state = 'ready'").all(owner, projectId) as { kind: string; hash: string; r2_key: string }[];
  const r2ok = await Promise.all(objects.map(async (o) => sha(h.env.BUCKET.read(o.r2_key)!) === o.hash));
  return { head: row?.head ?? null, tombstoned: !!row?.tombstoned_at, revs, branches, objects, r2ok: r2ok.every(Boolean) };
}

describe('first connection is the user\'s choice', () => {
  it('a logged-in device does not upload a local project until link() is called', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(1000, 1)]);
    await A.engine.syncAll({ force: true });
    expect(h.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/v1/projects'))).toEqual([]);
    expect((await A.engine.status(p.id)).state).toBe('local-only');
    expect(await A.store.outbox()).toEqual([]);
    await A.engine.link(p.id);
    await A.engine.syncAll();
    expect((await A.engine.status(p.id)).state).toBe('synced');
  });
});

describe('C01: two devices on the same remote base → 1 success + 1 conflict, both works kept', () => {
  it('link → restore on device B → offline edits on both → concurrent sync → keep local as new project / open remote', async () => {
    const h = setup();
    const A = await device(h, 'a'), B = await device(h, 'b');
    await A.login('alice'); await B.login('alice');
    const assets = [bytesOf(150_000, 1), bytesOf(10, 2)];
    const { p } = await newProjectWithAssets(A, assets, 'Two devices');
    await A.engine.link(p.id); await A.engine.syncAll();
    const recA = (await A.store.getRecord(p.id))!;
    let srv = await server(h, A.owner!, p.id);
    expect(srv.head).toBe(recA.head); expect(srv.r2ok).toBe(true); expect(srv.objects.length).toBe(3);
    // 다른 기기 복원
    expect((await B.engine.remoteProjects()).map((x) => x.id)).toEqual([p.id]);
    const cl = await B.engine.clone(p.id); expect(cl.ok).toBe(true);
    const pb = await B.project(p.id);
    expect(pb.title).toBe('Two devices');
    for (const a of assets) expect(sha(new Uint8Array(await (await B.store.readAsset(sha(a)))!.arrayBuffer()))).toBe(sha(a)); // 원본 SHA 동일
    expect((await B.store.revision(recA.head!))!.snapshotHash).toBe((await A.store.revision(recA.head!))!.snapshotHash);
    expect((await B.engine.status(p.id)).state).toBe('synced');
    // 두 기기 오프라인 수정(서로 다른 변경)
    const ra = await A.edit(p.id, (x) => { x.title = 'A edit'; });
    const rb = await B.edit(p.id, (x) => { x.title = 'B edit'; x.tempoMap[0].bpm = 99; });
    // 동시에 동기화
    await Promise.all([A.engine.syncAll(), B.engine.syncAll()]);
    const sa = await A.engine.status(p.id), sb = await B.engine.status(p.id);
    expect([sa.state, sb.state].sort()).toEqual(['conflict', 'synced']);
    const [win, lose, loseRev, winRev] = sa.state === 'synced' ? [A, B, rb, ra] : [B, A, ra, rb];
    srv = await server(h, A.owner!, p.id);
    expect(srv.head).toBe(winRev.id);
    expect(srv.branches).toEqual([{ revision_id: loseRev.id, reason: 'conflict' }]); // 진 쪽 작업도 서버에 보존
    expect(srv.revs.map((r) => r.revision_id).sort()).toEqual([recA.head, ra.id, rb.id].sort());
    // 진 쪽 로컬은 그대로(자동 병합·덮어쓰기 없음)
    expect((await lose.store.getRecord(p.id))!.head).toBe(loseRev.id);
    const c = (await lose.store.conflict(p.id))!;
    expect(c).toMatchObject({ localRevision: loseRev.id, remoteHead: winRev.id, base: recA.head, retainedRevision: loseRev.id, remoteDeleted: false });
    // 해결 (1) 로컬을 새 프로젝트로 보관 → 원래 프로젝트는 원격 head
    const kept = await lose.engine.keepLocalAsNewProject(p.id);
    if (!kept.ok) throw new Error(JSON.stringify(kept.errors));
    const copy = await lose.project(kept.value.newProjectId);
    expect(copy.title).toBe(`${loseRev === rb ? 'B edit' : 'A edit'} (로컬 분기)`);
    expect(copy.metadata.originProjectId).toBe(p.id);
    expect((await lose.project(p.id)).title).toBe(loseRev === rb ? 'A edit' : 'B edit');
    expect((await lose.store.getRecord(p.id))!.head).toBe(winRev.id);
    expect((await lose.engine.status(p.id)).state).toBe('synced');
    expect((await lose.store.branches(p.id)).map((b) => b.revisionId)).toContain(loseRev.id);
    expect((await lose.store.revision(loseRev.id))!.pinned).toBe(true); // 로컬 분기 삭제 안 함
    expect((await lose.store.getRecord(kept.value.newProjectId))!.syncStatus).toBe('local-only'); // 새 프로젝트 연결은 사용자 선택
    void win;
  });

  it('manual compare path: remote copy for comparison → user merges locally → upload on top of the seen remote head (no LWW)', async () => {
    const h = setup();
    const A = await device(h, 'a'), B = await device(h, 'b');
    await A.login('alice'); await B.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(5000, 3)], 'Merge me');
    await A.engine.link(p.id); await A.engine.syncAll();
    await B.engine.clone(p.id);
    const ra = await A.edit(p.id, (x) => { x.title = 'remote title'; });
    await A.engine.syncAll();
    await B.edit(p.id, (x) => { x.tempoMap[0].bpm = 133; });
    await B.engine.syncAll();
    expect((await B.engine.status(p.id)).state).toBe('conflict');
    const cmp = await B.engine.remoteCopyForCompare(p.id);
    if (!cmp.ok) throw new Error();
    expect((await B.project(cmp.value.newProjectId)).title).toBe('remote title (원격 사본)');
    expect((await B.store.getRecord(p.id))!.syncStatus).toBe('conflict'); // 비교만으로는 아무것도 바뀌지 않음
    // 사용자가 수동 병합: 원격 제목 + 로컬 템포
    const merged = await B.edit(p.id, (x) => { x.title = 'remote title'; });
    expect((await B.store.getRecord(p.id))!.syncStatus).toBe('conflict'); // 충돌 중 새 로컬 commit 도 상태 유지
    expect((await B.engine.resolveManually(p.id)).ok).toBe(true);
    await B.engine.syncAll();
    expect((await B.engine.status(p.id)).state).toBe('synced');
    const srv = await server(h, A.owner!, p.id);
    expect(srv.head).toBe(merged.id);
    const req = h.env.DB.raw.prepare('SELECT parent_ids FROM revisions WHERE revision_id = ?').get(merged.id) as { parent_ids: string };
    expect(JSON.parse(req.parent_ids)).toEqual([ra.id]); // 확인한 원격 head 위에 CAS
    // A 는 pull 로 fast-forward(깨끗한 경우만)
    expect(await A.engine.pull(p.id)).toBe('fast-forward');
    const pa = await A.project(p.id);
    expect([pa.title, pa.tempoMap[0].bpm]).toEqual(['remote title', 133]);
  });

  it('openRemote keeps the local branch pinned and listed', async () => {
    const h = setup();
    const A = await device(h, 'a'), B = await device(h, 'b');
    await A.login('alice'); await B.login('alice');
    const { p } = await newProjectWithAssets(A, [], 'Pick remote');
    await A.engine.link(p.id); await A.engine.syncAll(); await B.engine.clone(p.id);
    await A.edit(p.id, (x) => { x.title = 'A'; }); await A.engine.syncAll();
    const rb = await B.edit(p.id, (x) => { x.title = 'B'; }); await B.engine.syncAll();
    const r = await B.engine.openRemote(p.id); expect(r.ok).toBe(true);
    expect((await B.project(p.id)).title).toBe('A');
    expect((await B.store.branches(p.id)).map((x) => x.revisionId)).toEqual([rb.id]);
    const o = await B.store.open(p.id, rb.id); // 로컬 분기 그대로 열 수 있음
    expect(o.ok && o.value.project.title).toBe('B');
    expect(await B.store.outbox(p.id)).toEqual([]);
  });
});

describe('C02: disconnect/crash at every upload/verify/CAS/ack boundary → retry gives no duplicate head and no data loss', () => {
  const stages: SyncFaultStage[] = ['before-upload', 'after-upload', 'before-commit', 'after-commit-response', 'after-ack'];
  for (const stage of stages) it(`crash at ${stage} → restart → exactly one remote revision = local head`, async () => {
    const h = setup();
    let fired = false;
    const A = await device(h, 'a', { faultHook: (s) => { if (s === stage && !fired) { fired = true; throw new Error(`crash at ${s}`); } } });
    await A.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(200_000, 4), bytesOf(77, 5)]);
    await A.engine.link(p.id);
    await A.engine.syncAll();
    expect(fired).toBe(true);
    A.restart({ faultHook: undefined });
    await A.engine.syncAll({ force: true });
    const rec = (await A.store.getRecord(p.id))!;
    const srv = await server(h, A.owner!, p.id);
    expect(srv.head).toBe(rec.head);
    expect(srv.revs.length).toBe(1); // 중복 head/revision 없음
    expect(srv.branches).toEqual([]);
    expect(srv.r2ok).toBe(true);
    expect(rec.remoteHead).toBe(rec.head);
    expect(rec.syncStatus).toBe('synced');
    expect(await A.store.outbox()).toEqual([]);
    expect((h.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM idempotency').get() as { n: number }).n).toBe(1);
  });

  it('commit response lost after the server committed → same key retry reuses the stored result', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(3000, 1)]);
    await A.engine.link(p.id);
    h.faults.push({ match: /^POST \/v1\/projects\/[^/]+\/commits$/, mode: 'drop-response', times: 1 });
    await A.engine.syncAll();
    const e = (await A.store.outbox())[0];
    expect(e.attempts).toBe(1); expect(e.request).not.toBeNull(); // payload 고정
    expect((await server(h, A.owner!, p.id)).head).toBe(e.revisionId); // 서버는 이미 commit
    await A.store.acquireLease(p.id);
    await A.edit(p.id, (x) => { x.title = 'newer edit while offline'; }); // 새 편집은 별도 항목
    await A.engine.syncAll({ force: true });
    const srv = await server(h, A.owner!, p.id);
    expect(srv.revs.length).toBe(2); expect(srv.branches).toEqual([]);
    expect(srv.head).toBe((await A.store.getRecord(p.id))!.head);
    expect(h.calls.filter((c) => c.path.endsWith('/commits')).length).toBe(3);
  });

  it('network failures back off 1/2/4 s (jitter fixed) and keep the frozen payload; 429 follows Retry-After', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(3000, 1)]);
    await A.engine.link(p.id);
    h.faults.push({ match: /^PUT \/v1\/chunks\//, mode: 'network', times: 3 });
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await A.engine.syncAll({ force: true });
      const e = (await A.store.outbox())[0];
      delays.push(e.nextAt - h.now());
      expect((await A.engine.status(p.id)).state).toBe('offline');
    }
    expect(delays).toEqual([1000, 2000, 4000]);
    const key = (await A.store.outbox())[0].idempotencyKey;
    await A.engine.syncAll(); // 아직 due 아님 → 아무것도 보내지 않음
    expect((await A.store.outbox()).length).toBe(1);
    h.tick(4000);
    await A.engine.syncAll();
    expect((await A.engine.status(p.id)).state).toBe('synced');
    expect((h.env.DB.raw.prepare('SELECT idem_key FROM idempotency').get() as { idem_key: string }).idem_key).toBe(key);
    // 429
    const h2 = setup({ RATE_LIMIT_PER_MIN: '4' });
    const B = await device(h2, 'b'); await B.login('bob');
    const q = await newProjectWithAssets(B, [bytesOf(70_000, 2)]);
    await B.engine.link(q.p.id);
    await B.engine.syncAll();
    const e = (await B.store.outbox())[0];
    const wait = e.nextAt - h2.now();
    expect(wait).toBeGreaterThan(0); expect(wait).toBeLessThanOrEqual(60_000);
    expect(wait % 1000).toBe(0); // Retry-After(초) 그대로, jitter 없음
    h2.tick(61_000);
    for (let i = 0; i < 5 && (await B.store.outbox()).length; i++) { await B.engine.syncAll({ force: true }); h2.tick(61_000); }
    expect((await B.engine.status(q.p.id)).state).toBe('synced');
  });

  it('server-side hash mismatch is reported (not ready, not committed) and the local original is never modified', async () => {
    const h = setup({ VERIFY_BUDGET_BYTES: String(65536) });
    const A = await device(h, 'a'); await A.login('alice');
    const asset = bytesOf(200_000, 8);
    const { p } = await newProjectWithAssets(A, [asset]);
    await A.engine.link(p.id);
    // 검증 job 이 첫 구간을 읽은 뒤 R2 객체가 손상됨(저장 경로 손상 흉내)
    let completes = 0;
    h.hooks.onRequest = (m, path) => { if (m === 'POST' && path.endsWith('/complete') && ++completes === 2) for (const k of h.env.BUCKET.keys()) if (k.includes(`/${sha(asset)}/`)) h.env.BUCKET.tamper(k, (b) => { b[150_000] ^= 1; return b; }); };
    await A.engine.syncAll();
    h.hooks.onRequest = null;
    const st = await A.engine.status(p.id);
    expect(st.state).toBe('error'); expect(st.error).toMatch(/OBJECT_CHANGED|HASH_MISMATCH/);
    expect((await server(h, A.owner!, p.id)).head).toBeNull();
    const local = await A.store.readAsset(sha(asset));
    expect(sha(new Uint8Array(await local!.arrayBuffer()))).toBe(sha(asset));
    await A.engine.syncAll({ force: true }); // 사용자 재시도: 새 업로드 → 서버 검증 통과
    expect((await A.engine.status(p.id)).state).toBe('synced');
    expect((await server(h, A.owner!, p.id)).r2ok).toBe(true);
  });
});

describe('C03: delete vs offline edit, logout / account switch, expired session and URLs', () => {
  it('remote delete never deletes the offline-edited local copy; restore with my version via CAS', async () => {
    const h = setup();
    const A = await device(h, 'a'), B = await device(h, 'b');
    await A.login('alice'); await B.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(4000, 1)], 'Delete me');
    await A.engine.link(p.id); await A.engine.syncAll(); await B.engine.clone(p.id);
    expect((await A.engine.deleteRemote(p.id)).ok).toBe(true);
    expect((await A.store.getRecord(p.id))!.syncStatus).toBe('local-only'); // A 의 로컬 사본은 보존
    expect((await server(h, A.owner!, p.id)).tombstoned).toBe(true);
    const rb = await B.edit(p.id, (x) => { x.title = 'offline work'; });
    await B.engine.syncAll();
    expect((await B.engine.status(p.id)).state).toBe('conflict');
    expect((await B.store.conflict(p.id))!.remoteDeleted).toBe(true);
    expect((await B.project(p.id)).title).toBe('offline work'); // 자동 삭제 없음
    expect((await B.engine.openRemote(p.id)).ok).toBe(false);  // 삭제된 원격은 "열기" 불가 → 복원/로컬 유지만
    expect((await B.engine.restoreRemoteWithLocal(p.id)).ok).toBe(true);
    const srv = await server(h, A.owner!, p.id);
    expect(srv.tombstoned).toBe(false);
    expect(srv.revs.find((r) => r.revision_id === srv.head)!.snapshot_hash).toBe((await B.store.revision(rb.id))!.snapshotHash);
    expect((await B.engine.status(p.id)).state).toBe('synced');
    // A(연결 해제됨)는 pull 대상 아님. 깨끗한 다른 기기는 pull 로 remote-deleted 만 표시
    const C = await device(h, 'c'); await C.login('alice'); await C.engine.clone(p.id);
    expect((await A.engine.remoteProjects()).find((x) => x.id === p.id)!.tombstoned).toBe(false);
    void C;
  });

  it('clean device sees remote-deleted without losing its copy', async () => {
    const h = setup();
    const A = await device(h, 'a'), B = await device(h, 'b');
    await A.login('alice'); await B.login('alice');
    const { p } = await newProjectWithAssets(A, [], 'X');
    await A.engine.link(p.id); await A.engine.syncAll(); await B.engine.clone(p.id);
    await A.engine.deleteRemote(p.id);
    expect(await B.engine.pull(p.id)).toBe('remote-deleted');
    expect((await B.engine.status(p.id)).remoteDeleted).toBe(true);
    expect((await B.project(p.id)).title).toBe('X');
    expect((await B.engine.restoreRemoteWithLocal(p.id)).ok).toBe(true);
    expect((await server(h, A.owner!, p.id)).tombstoned).toBe(false);
  });

  it('logout keeps local data; another account never receives the previous account\'s outbox; re-login resumes', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice');
    const { p } = await newProjectWithAssets(A, [bytesOf(2000, 1)]);
    await A.engine.link(p.id); await A.engine.syncAll();
    await A.edit(p.id, (x) => { x.title = 'pending edit'; });
    A.logout();
    expect((await A.engine.status(p.id)).state).toBe('auth-required');
    expect((await A.store.outbox()).length).toBe(1);
    expect((await A.project(p.id)).title).toBe('pending edit');
    await A.login('mallory');
    const before = h.calls.length;
    await A.engine.syncAll({ force: true });
    expect(h.calls.slice(before).filter((c) => c.path.startsWith('/v1/projects') || c.path.startsWith('/v1/chunks'))).toEqual([]);
    expect((await A.engine.status(p.id)).state).toBe('auth-required');
    expect((await A.engine.link(p.id)).ok).toBe(false); // 다른 계정으로 재연결 불가
    expect((await h.raw('GET', '/v1/projects', (await h.login('mallory')).token).then((r) => r.json())).projects).toEqual([]);
    await A.login('alice');
    await A.engine.syncAll({ force: true });
    expect((await A.engine.status(p.id)).state).toBe('synced');
    expect((await server(h, 'fake:alice', p.id)).head).toBe((await A.store.getRecord(p.id))!.head);
  });

  it('expired session → auth-required with the outbox intact; re-login completes without duplicates', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice', 5);
    const { p } = await newProjectWithAssets(A, [bytesOf(2000, 1)]);
    await A.engine.link(p.id);
    h.tick(6000);
    await A.engine.syncAll();
    expect((await A.engine.status(p.id)).state).toBe('auth-required');
    const e = (await A.store.outbox())[0];
    expect(e.attempts).toBe(0);
    await A.login('alice');
    await A.engine.syncAll();
    expect((await A.engine.status(p.id)).state).toBe('synced');
    expect((await server(h, 'fake:alice', p.id)).revs.length).toBe(1);
  });

  it('expired upload URLs and expired download URLs are refreshed safely', async () => {
    const h = setup({ URL_TTL_SEC: '30' });
    const A = await device(h, 'a'), B = await device(h, 'b');
    await A.login('alice', 7200); await B.login('alice', 7200);
    const big = bytesOf(4 * 65536, 9);
    const { p } = await newProjectWithAssets(A, [big]);
    await A.engine.link(p.id);
    let n = 0;
    h.hooks.onRequest = (m, path) => { if (m === 'PUT' && path.startsWith('/v1/chunks/') && ++n === 2) h.tick(31_000); };
    await A.engine.syncAll();
    expect((await A.engine.status(p.id)).state).toBe('synced');
    expect(h.calls.some((c) => c.method === 'PUT' && c.status === 403)).toBe(true);
    let d = 0;
    h.hooks.onRequest = (m, path) => { if (m === 'GET' && path.startsWith('/v1/blobs/') && ++d === 1) h.tick(31_000); };
    expect((await B.engine.clone(p.id)).ok).toBe(true);
    expect(sha(new Uint8Array(await (await B.store.readAsset(sha(big)))!.arrayBuffer()))).toBe(sha(big));
  });
});

describe('C06: local GC never deletes pinned / outbox / conflict / Undo / recording assets', () => {
  it('reachability', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice');
    const X = bytesOf(500, 1), Y = bytesOf(501, 2), Z = bytesOf(502, 3), W = bytesOf(503, 4), U = bytesOf(504, 5), J = bytesOf(505, 6);
    const { p } = await newProjectWithAssets(A, [X], 'GC');
    await A.engine.link(p.id);
    // rev0(X) 의 outbox 항목은 전송 시도 중(payload 고정) — 응답 유실 상태
    h.faults.push({ match: /^POST \/v1\/projects\/[^/]+\/commits$/, mode: 'network', times: 1 });
    await A.engine.syncAll();
    const rev0 = (await A.store.outbox())[0].revisionId;
    const imp = async (b: Uint8Array) => { const r = await A.store.importAsset(b); if (!r.ok) throw new Error(); return r.value.hash; };
    const setAsset = (x: Project, b: Uint8Array, i: number) => { x.assets = [{ id: fid(60 + i), sha256: sha(b), byteLength: b.length, mediaType: 'audio/wav', audio: null, license: { name: 'self-recorded', origin: 'user', redistribution: 'allowed' } }]; };
    for (const b of [Y, Z, W, U, J]) await imp(b);
    const r1 = await A.edit(p.id, (x) => setAsset(x, Y, 1));
    const r2 = await A.edit(p.id, (x) => setAsset(x, Z, 2));
    const r3 = await A.edit(p.id, (x) => setAsset(x, W, 3));
    for (let i = 0; i < 101; i++) await A.edit(p.id, (x) => { x.assets = []; x.title = `t${i}`; });
    await A.store.pinRevision(r2.id, true);
    await A.store.recordConflict({ projectId: p.id, ownerId: A.owner!, localRevision: r1.id, localHeadAtDetect: r1.id, remoteHead: null, base: null, retainedRevision: r1.id, remoteDeleted: false, detectedAt: '', entryId: 'none' });
    await A.store.putJournal({ id: 'rec1', projectId: p.id, kind: 'recording', state: 'open', assetHashes: [sha(J)] });
    const later = h.now() + 9 * 86_400_000;
    const g = await A.store.gc({ now: later, extraReachable: [sha(U)] }); // Undo 스택이 참조하는 자산
    expect(g.revisions).toContain(r3.id);
    for (const keep of [rev0, r1.id, r2.id]) expect(g.revisions).not.toContain(keep);
    expect(g.assets).toEqual([sha(W)]);
    for (const b of [X, Y, Z, U, J]) expect(await A.store.readAsset(sha(b))).not.toBeNull();
    expect(await A.store.readAsset(sha(W))).toBeNull();
    const o = await A.store.open(p.id, r1.id); expect(o.ok).toBe(true);
  });
});

describe('local commit records the outbox entry in the same IndexedDB transaction', () => {
  it('a commit aborted at step 5 leaves neither a new head nor an outbox entry; never-sent entries coalesce', async () => {
    const h = setup();
    const A = await device(h, 'a'); await A.login('alice');
    const { p } = await newProjectWithAssets(A, [], 'Atomic');
    await A.engine.link(p.id);
    const before = await A.store.outbox();
    expect(before.length).toBe(1);
    A.store.faultHook = (s) => { if (s === 5) throw new Error('crash in tx'); };
    await expect(A.edit(p.id, (x) => { x.title = 'lost'; })).rejects.toThrow();
    A.store.faultHook = null;
    expect(await A.store.outbox()).toEqual(before);
    const r = await A.edit(p.id, (x) => { x.title = 'kept'; });
    const after = await A.store.outbox();
    expect(after.map((e) => e.revisionId)).toEqual([r.id]); // 미전송 이전 항목은 최신 revision 으로 대체
    expect(deserializeProject((await A.store.snapshotBytes(r.snapshotHash))!).ok).toBe(true);
  });
});
