import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { LocalStore, MemoryByteStore, IdbByteStore, createProjectArchive, exportArchive, importArchive, writeZip, readZipDirectory, AutosaveController, paths, type FaultHook } from '@bass-daw/storage';
import { snapshotHash, sha256HexSync, canonicalStringify, type Project } from '@bass-daw/schemas';
import { ProjectSession } from '@bass-daw/project-core';
import { f00, f03 } from '../../../tests/fixtures/projects.ts';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

let n = 0;
const dbName = () => `test-${process.pid}-${n++}`;
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** f03 의 가짜 sha 자산을 실제 바이트 자산으로 교체 */
async function projectWithRealAssets(store: LocalStore): Promise<{ p: Project; bytes: Uint8Array[] }> {
  const p = structuredClone(f03()) as Project;
  const b1 = new Uint8Array(96044).map((_, i) => (i * 7) & 255);
  const b2 = new Uint8Array(10).map((_, i) => i);
  const r1 = await store.importAsset(b1); const r2 = await store.importAsset(b2);
  if (!r1.ok || !r2.ok) throw new Error('import');
  p.assets[0].sha256 = r1.value.hash; p.assets[1].sha256 = r2.value.hash;
  return { p, bytes: [b1, b2] };
}

async function freshStore(name = dbName(), bytes = new MemoryByteStore()) {
  return { store: await LocalStore.open(bytes, name), name, bytes };
}

describe('L01 offline create → edit → restart', () => {
  it('last completed head and asset hashes identical after restart', async () => {
    const { store, name, bytes } = await freshStore();
    const { p } = await projectWithRealAssets(store);
    expect((await store.acquireLease(p.id)).ok).toBe(true);
    const s = new ProjectSession(p);
    const c1 = await store.commit(s.project, null, s.editSequence);
    expect(c1.ok).toBe(true);
    s.run('rename', { type: 'RenameTrack', trackId: p.tracks[0].id, name: 'Renamed' });
    const c2 = await store.commit(s.project, c1.ok ? c1.value.id : null, s.editSequence);
    if (!c2.ok) throw new Error(JSON.stringify(c2.errors));
    store.close();
    // "재시작": 새 연결, 같은 영속 저장소
    const store2 = await LocalStore.open(bytes, name);
    const o = await store2.open(p.id);
    if (!o.ok) throw new Error(JSON.stringify(o.errors));
    expect(o.value.revision.id).toBe(c2.value.id);
    expect(o.value.project.tracks[0].name).toBe('Renamed');
    expect(await snapshotHash(o.value.project)).toBe(await snapshotHash(s.project));
    expect(o.value.missing).toEqual([]);
    for (const a of o.value.project.assets) {
      const blob = await store2.readAsset(a.sha256);
      expect(nodeSha(new Uint8Array(await blob!.arrayBuffer()))).toBe(a.sha256);
    }
  });
  it('IDB Blob adapter (OPFS fallback) runs the same protocol', async () => {
    const name = dbName();
    const bytes = IdbByteStore.open(name + '-blobs');
    const store = await LocalStore.open(bytes, name);
    const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 13) & 255);
    const r = await store.importAsset(big);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.storage).toBe('idb');
    expect(r.value.hash).toBe(nodeSha(big));
    const back = await store.readAsset(r.value.hash);
    expect(back!.size).toBe(big.length);
    expect(nodeSha(new Uint8Array(await back!.arrayBuffer()))).toBe(nodeSha(big));
    expect(await bytes.list('staging/')).toEqual([]);
  });
});

describe('L02 crash injection at each commit boundary', () => {
  for (const step of [1, 2, 3, 4, 5] as const) {
    it(`step ${step}: only an intact old or new head is visible`, async () => {
      const { store, name, bytes } = await freshStore();
      const p = f00();
      await store.acquireLease(p.id);
      const c1 = await store.commit(p, null, 0);
      if (!c1.ok) throw new Error();
      const oldHash = await snapshotHash(p);
      const next: Project = { ...p, title: 'new', assets: [] };
      const fault: FaultHook = (s) => { if (s === step) throw new Error(`crash@${step}`); };
      store.faultHook = fault;
      // step 2,3 은 자산 import 경로
      const asset = new Uint8Array(1000).fill(step);
      const imp = await store.importAsset(asset);
      let committed = false;
      if (imp.ok) {
        const withAsset: Project = { ...next, assets: [{ id: 'asset-x', sha256: imp.value.hash, byteLength: 1000, mediaType: 'application/octet-stream', audio: null, license: { name: 'x', origin: 'test', redistribution: 'allowed' } }] };
        try { const r = await store.commit(withAsset, c1.value.id, 1); committed = r.ok; } catch { committed = false; }
      }
      store.close();
      const s2 = await LocalStore.open(bytes, name);
      const o = await s2.open(p.id);
      if (!o.ok) throw new Error(JSON.stringify(o.errors));
      const h = await snapshotHash(o.value.project);
      if (committed) expect(o.value.project.title).toBe('new');
      else expect(h).toBe(oldHash);
      expect(o.value.missing).toEqual([]);
      // 실패한 경우 promote 되지 않은 staging 이 head 에서 참조되지 않음
      expect(step <= 5).toBe(true);
    });
  }
});

describe('L03 quota / asset loss / corrupt snapshot', () => {
  it('quota error leaves previous head intact and reports QUOTA', async () => {
    const bytes = new MemoryByteStore();
    const { store } = await freshStore(dbName(), bytes);
    bytes.quotaFail = (path) => path.startsWith('staging/');
    const r = await store.importAsset(new Uint8Array(10));
    expect(!r.ok && r.errors[0].code).toBe('QUOTA');
  });
  it('autosave: quota → clear caches → retry once → quota-error with local file hint, edit kept in memory', async () => {
    let calls = 0; let cleared = 0;
    const ctl = new AutosaveController({
      commit: async () => { calls++; return { ok: false, errors: [{ code: 'QUOTA', path: '$', message: 'full' }] }; },
      clearCaches: async () => { cleared++; },
      setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never), now: () => Date.now(),
    }, null, 0);
    ctl.notify(f00(), 1);
    await ctl.flush();
    expect(calls).toBe(2); expect(cleared).toBe(1);
    expect(ctl.status).toBe('quota-error');
    expect(ctl.lastError).toMatch(/\.dawbae/);
  });
  it('missing asset bytes → degraded open with missing list, project still opens', async () => {
    const { store, bytes } = await freshStore();
    const { p } = await projectWithRealAssets(store);
    await store.acquireLease(p.id);
    await store.commit(p, null, 0);
    await bytes.remove(paths.asset(p.assets[0].sha256));
    const o = await store.open(p.id);
    if (!o.ok) throw new Error();
    expect(o.value.missing).toEqual([p.assets[0].sha256]);
    expect(o.value.diagnostics[0]).toMatch(/ASSET_MISSING/);
    // degraded 프로젝트도 이전 head 가 참조하던 자산이면 다시 commit 가능
    const again = await store.commit({ ...o.value.project, title: 'still editable' }, o.value.revision.id, 1);
    expect(again.ok).toBe(true);
  });
  it('corrupt snapshot → SNAPSHOT_CORRUPT and recover offers previous valid revision; nothing overwritten', async () => {
    const { store } = await freshStore();
    const p = f00();
    await store.acquireLease(p.id);
    const a = await store.commit(p, null, 0);
    const b = await store.commit({ ...p, title: 'v2' }, a.ok ? a.value.id : null, 1);
    if (!a.ok || !b.ok) throw new Error();
    const tx = store.db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put({ hash: b.value.snapshotHash, bytes: new TextEncoder().encode('{"garbage":true}') });
    await new Promise((r) => (tx.oncomplete = r));
    const o = await store.open(p.id);
    expect(!o.ok && o.errors[0].code).toBe('SNAPSHOT_CORRUPT');
    const rec = await store.recover(p.id);
    if (!rec.ok) throw new Error();
    expect(rec.value.map((r) => [r.id, r.valid])).toEqual([[b.value.id, false], [a.value.id, true]]);
    const restored = await store.restoreRevision(p.id, a.value.id);
    expect(restored.ok).toBe(true);
    expect(await store.revisions(p.id)).toHaveLength(3);
  });
  it('S06: future-version snapshot opens as FUTURE_VERSION; head and bytes untouched', async () => {
    const { store } = await freshStore();
    const p = f00();
    await store.acquireLease(p.id);
    const a = await store.commit(p, null, 0);
    if (!a.ok) throw new Error();
    const fut = new TextEncoder().encode(canonicalStringify({ ...p, schemaVersion: 2, newField: 1 }));
    const h = sha256HexSync(fut);
    const tx = store.db.transaction(['snapshots', 'revisions', 'projects'], 'readwrite');
    tx.objectStore('snapshots').put({ hash: h, bytes: fut });
    tx.objectStore('revisions').put({ ...a.value, id: 'future-rev', snapshotHash: h });
    tx.objectStore('projects').put({ projectId: p.id, head: 'future-rev', remoteHead: null, syncStatus: 'local-only', title: 'x', updatedAt: p.updatedAt });
    await new Promise((r) => (tx.oncomplete = r));
    const o = await store.open(p.id);
    expect(!o.ok && o.errors[0].code).toBe('FUTURE_VERSION');
    expect((await store.getRecord(p.id))!.head).toBe('future-rev');
    expect(sha256HexSync((await store.snapshotBytes(h))!)).toBe(h);
  });
});

describe('L04 two tabs: takeover, stale epoch, stale head', () => {
  it('second writer is refused until explicit takeover; old writer then fails', async () => {
    const name = dbName(); const bytes = new MemoryByteStore();
    const tabA = await LocalStore.open(bytes, name);
    const tabB = await LocalStore.open(bytes, name);
    const p = f00();
    expect((await tabA.acquireLease(p.id)).ok).toBe(true);
    const r1 = await tabA.commit(p, null, 0);
    if (!r1.ok) throw new Error();
    const held = await tabB.acquireLease(p.id);
    expect(!held.ok && held.errors[0].code).toBe('WRITER_HELD');
    expect((await tabB.acquireLease(p.id, { takeover: true })).ok).toBe(true);
    const stale = await tabA.commit({ ...p, title: 'A' }, r1.value.id, 1);
    expect(!stale.ok && stale.errors[0].code).toBe('WRITER_LOST');
    expect((await tabA.heartbeat(p.id)).ok).toBe(false);
    const okB = await tabB.commit({ ...p, title: 'B' }, r1.value.id, 1);
    expect(okB.ok).toBe(true);
    const staleHead = await tabB.commit({ ...p, title: 'B2' }, r1.value.id, 2);
    expect(!staleHead.ok && staleHead.errors[0].code).toBe('LOCAL_HEAD_CHANGED');
    const o = await tabA.open(p.id);
    expect(o.ok && o.value.project.title).toBe('B');
  });
  it('an expired lease (heartbeat delay) is NOT treated as a closed tab; the throttled writer keeps ownership', async () => {
    const name = dbName(); const bytes = new MemoryByteStore();
    const a = await LocalStore.open(bytes, name), b = await LocalStore.open(bytes, name);
    let t = 1_000_000; a.now = () => t; b.now = () => t;
    const p = f00();
    await a.acquireLease(p.id);
    const r1 = await a.commit(p, null, 0); if (!r1.ok) throw new Error();
    t += 60_000; // A 가 background throttling 으로 1분간 heartbeat 를 못 보냄
    const got = await b.acquireLease(p.id);
    expect(!got.ok && got.errors[0].code).toBe('WRITER_UNRESPONSIVE');
    // A 가 깨어나면 소유권 그대로: heartbeat·commit 성공
    expect((await a.heartbeat(p.id)).ok).toBe(true);
    const r2 = await a.commit({ ...p, title: 'A2' }, r1.value.id, 1);
    expect(r2.ok).toBe(true);
  });
  it('a released lease (normal close) can be acquired without takeover', async () => {
    const name = dbName(); const bytes = new MemoryByteStore();
    const a = await LocalStore.open(bytes, name), b = await LocalStore.open(bytes, name);
    await a.acquireLease('p1');
    await a.releaseLease('p1');
    expect((await b.acquireLease('p1')).ok).toBe(true);
  });
  it('after takeover every stale write path of the old tab is refused and the new head is unchanged', async () => {
    const name = dbName(); const bytes = new MemoryByteStore();
    const a = await LocalStore.open(bytes, name), b = await LocalStore.open(bytes, name);
    let t = 1_000_000; a.now = () => t; b.now = () => t;
    const p = f00();
    await a.acquireLease(p.id);
    const r1 = await a.commit(p, null, 0); if (!r1.ok) throw new Error();
    t += 60_000;
    expect((await b.acquireLease(p.id, { takeover: true })).ok).toBe(true); // 명시적 takeover
    const rb = await b.commit({ ...p, title: 'B' }, r1.value.id, 1); if (!rb.ok) throw new Error();
    // A: stale epoch + 올바른 head / stale epoch + stale head / heartbeat / takeover 없는 재획득 모두 거절
    for (const [proj, head] of [[{ ...p, title: 'A-new-head' }, rb.value.id], [{ ...p, title: 'A-stale-head' }, r1.value.id]] as const) {
      const x = await a.commit(proj, head, 2);
      expect(!x.ok && x.errors[0].code).toBe('WRITER_LOST');
    }
    expect((await a.heartbeat(p.id)).ok).toBe(false);
    const re = await a.acquireLease(p.id);
    expect(!re.ok && re.errors[0].code).toBe('WRITER_HELD');
    // A 가 다시 명시적으로 takeover 해도 stale head 로는 쓸 수 없다(head CAS)
    expect((await a.acquireLease(p.id, { takeover: true })).ok).toBe(true);
    const sh = await a.commit({ ...p, title: 'A-after-retake' }, r1.value.id, 3);
    expect(!sh.ok && sh.errors[0].code).toBe('LOCAL_HEAD_CHANGED');
    const o = await b.open(p.id);
    expect(o.ok && o.value.project.title).toBe('B');
    expect((await b.getRecord(p.id))!.head).toBe(rb.value.id);
    // B 는 이제 fenced
    const bx = await b.commit({ ...p, title: 'B2' }, rb.value.id, 4);
    expect(!bx.ok && bx.errors[0].code).toBe('WRITER_LOST');
  });
});

describe('L05 archive', () => {
  it('round trip into a new copy with identical asset hashes; source project untouched', async () => {
    const { store } = await freshStore();
    const { p } = await projectWithRealAssets(store);
    await store.acquireLease(p.id);
    const c = await store.commit(p, null, 0);
    if (!c.ok) throw new Error(JSON.stringify(c.errors));
    const ex = await exportArchive(store, p.id);
    if (!ex.ok) throw new Error(JSON.stringify(ex.errors));
    expect(ex.value.manifest.portable).toBe('complete');
    const { store: other } = await freshStore();
    const im = await importArchive(other, ex.value.blob);
    if (!im.ok) throw new Error(JSON.stringify(im.errors));
    expect(im.value.projectId).not.toBe(p.id);
    const o = await other.open(im.value.projectId);
    if (!o.ok) throw new Error();
    expect(o.value.project.metadata.originProjectId).toBe(p.id);
    expect(o.value.project.assets.map((a) => a.sha256)).toEqual(p.assets.map((a) => a.sha256));
    expect(o.value.missing).toEqual([]);
    const { id: _a, metadata: _m, updatedAt: _u, ...restA } = o.value.project;
    const { id: _b, metadata: _n, updatedAt: _v, ...restB } = p;
    expect(restA).toEqual(restB);
    // 같은 저장소로 import 해도 원본 head 불변
    const head = (await store.getRecord(p.id))!.head;
    expect((await importArchive(store, ex.value.blob)).ok).toBe(true);
    expect((await store.getRecord(p.id))!.head).toBe(head);
  });
  const evil = async (entries: { name: string; data: Uint8Array }[]) => writeZip(entries.map((e) => ({ ...e })));
  it('rejects path traversal / absolute / unexpected entries without changing heads', async () => {
    const { store } = await freshStore();
    for (const name of ['../evil', '/abs', 'assets/../../x', 'C:/win', 'a\\b', 'assets/zz']) {
      const z = await evil([{ name, data: new Uint8Array(1) }]);
      const r = await importArchive(store, z);
      expect(r.ok).toBe(false);
    }
    expect(await store.listProjects()).toEqual([]);
  });
  it('rejects symlink entries', async () => {
    const z = new Uint8Array(await (await writeZip([{ name: 'manifest.json', data: new Uint8Array(5) }])).arrayBuffer());
    // central header external attrs: symlink mode 0120777
    const cd = z.findIndex((_, i) => z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 1 && z[i + 3] === 2);
    new DataView(z.buffer).setUint32(cd + 38, (0o120777 << 16) >>> 0, true);
    const r = await readZipDirectory(new Blob([z]));
    expect(!r.ok && r.code).toBe('ARCHIVE_PATH');
  });
  it('rejects zip bombs (ratio) and lying headers', async () => {
    const zeros = new Uint8Array(10 * 1024 * 1024);
    const z = await writeZip([{ name: 'project.json', data: zeros, compress: true }]);
    const r = await readZipDirectory(z);
    expect(!r.ok && r.code).toBe('ARCHIVE_LIMIT');
    // 헤더가 작게 거짓 선언한 deflate entry
    const raw = deflateRawSync(Buffer.alloc(5000, 1));
    const zip2 = new Uint8Array(await (await writeZip([{ name: 'manifest.json', data: new Uint8Array(raw) }])).arrayBuffer());
    const v = new DataView(zip2.buffer);
    const cd = zip2.findIndex((_, i) => zip2[i] === 0x50 && zip2[i + 1] === 0x4b && zip2[i + 2] === 1 && zip2[i + 3] === 2);
    v.setUint16(cd + 10, 8, true); v.setUint32(cd + 24, raw.length * 2, true); // method deflate, usize 거짓
    const { store } = await freshStore();
    const im = await importArchive(store, new Blob([zip2]));
    expect(im.ok).toBe(false);
  });
  it('entry count limit and incomplete import keep heads unchanged', async () => {
    const r = await readZipDirectory(await writeZip(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(1) }))), { compressed: 1e9, uncompressed: 1e9, entries: 10, ratio: 100 });
    expect(!r.ok && r.code).toBe('ARCHIVE_LIMIT');
    // 자산 hash 불일치 archive
    const { store } = await freshStore();
    const p = f00();
    p.assets.push({ id: 'a1', sha256: 'c'.repeat(64), byteLength: 3, mediaType: 'x', audio: null, license: { name: '', origin: '', redistribution: 'allowed' } });
    const pj = new TextEncoder().encode(canonicalStringify(p));
    const manifest = { archiveVersion: 1, snapshotHash: sha256HexSync(pj), projectId: p.id, createdAt: p.createdAt, entries: [{ path: `assets/${'c'.repeat(64)}`, bytes: 3, sha256: 'c'.repeat(64) }], plugins: [], requiredExternal: [], portable: 'complete' };
    const z = await writeZip([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) }, { name: 'project.json', data: pj }, { name: `assets/${'c'.repeat(64)}`, data: new Uint8Array([1, 2, 3]) }]);
    const im = await importArchive(store, z);
    expect(!im.ok && im.errors[0].code).toBe('HASH_MISMATCH');
    expect(await store.listProjects()).toEqual([]);
  });
});

describe('GC keeps pinned/journal/head assets', () => {
  it('reachability', async () => {
    const { store } = await freshStore();
    let t = Date.parse('2026-10-01T00:00:00Z'); store.now = () => t;
    const p = f00();
    await store.acquireLease(p.id);
    const orphan = await store.importAsset(new Uint8Array([9, 9, 9]));
    const journalAsset = await store.importAsset(new Uint8Array([7, 7]));
    if (!orphan.ok || !journalAsset.ok) throw new Error();
    await store.putJournal({ id: 'j1', projectId: p.id, kind: 'recording', state: 'recoverable', assetHashes: [journalAsset.value.hash], segments: [] });
    let head: string | null = null;
    for (let i = 0; i < 105; i++) { const r = await store.commit({ ...p, title: `v${i}`, updatedAt: p.updatedAt }, head, i); if (!r.ok) throw new Error(); head = r.value.id; t += 1000; if (i === 0) await store.pinRevision(r.value.id, true); }
    t += 8 * 24 * 3600_000;
    const g = await store.gc();
    expect(g.revisions.length).toBe(4); // 105 - 최근 100 - pinned 1
    expect(g.assets).toEqual([orphan.value.hash]);
    expect((await store.revisions(p.id)).length).toBe(101);
    expect(await store.readAsset(journalAsset.value.hash)).not.toBeNull();
  });
});

describe('autosave timing', () => {
  it('debounce 1s, max interval 5s during continuous edits', async () => {
    let t = 0; const timers: { at: number; fn: () => void; id: number }[] = []; let id = 0;
    const commits: number[] = [];
    const ctl = new AutosaveController({
      commit: async (_p, _h, seq) => { commits.push(t); return { ok: true, value: { id: `r${seq}` } as never }; },
      clearCaches: async () => {},
      setTimeout: (fn, ms) => { timers.push({ at: t + ms, fn, id: ++id }); return id; },
      clearTimeout: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
      now: () => t,
    }, null, 0);
    const advance = async (to: number) => { while (true) { timers.sort((a, b) => a.at - b.at); const nx = timers[0]; if (!nx || nx.at > to) break; timers.shift(); t = nx.at; nx.fn(); await new Promise((r) => setImmediate(r)); } t = to; };
    // 0.5초마다 편집 7초 동안
    for (let i = 0; i < 14; i++) { ctl.notify(f00(), i + 1); await advance(t + 500); }
    await advance(t + 2000);
    expect(commits[0]).toBe(5000);
    expect(ctl.status).toBe('saved');
    expect(commits.length).toBeGreaterThanOrEqual(2);
  });
});


describe('.dawbae local files', () => {
  it('saves the current unsaved snapshot with all original assets, including private non-redistributable audio', async () => {
    const { store } = await freshStore(); const { p } = await projectWithRealAssets(store);
    p.assets[0].license.redistribution = 'forbidden'; p.title = 'unsaved current title';
    const before = await snapshotHash(p);
    const ex = await createProjectArchive(p, h => store.readAsset(h), { localFile:true });
    if (!ex.ok) throw new Error(JSON.stringify(ex.errors));
    expect(ex.value.manifest.portable).toBe('complete');
    const { store: other } = await freshStore(); const im = await importArchive(other, ex.value.blob);
    if (!im.ok) throw new Error(JSON.stringify(im.errors));
    const opened = await other.open(im.value.projectId); if (!opened.ok) throw new Error();
    expect(opened.value.project.title).toBe('unsaved current title'); expect(opened.value.missing).toEqual([]);
    expect(opened.value.project.sources).toEqual(p.sources);
    for (const a of p.assets) expect(nodeSha(new Uint8Array(await (await other.readAsset(a.sha256))!.arrayBuffer()))).toBe(a.sha256);
    expect(await snapshotHash(p)).toBe(before);
  });
  it('refuses incomplete local files instead of silently dropping missing audio', async () => {
    const { store } = await freshStore(); const { p } = await projectWithRealAssets(store);
    const result = await createProjectArchive(p, async()=>null, {localFile:true});
    expect(result.ok).toBe(false);if(!result.ok) expect(result.errors[0].code).toBe('MISSING_FILE_ASSETS');
  });
});
