// 04 §2–4 LocalStore: IndexedDB(메타·snapshot·revision·head) + ByteStore(자산) 로컬 commit 프로토콜.
import type { Project, Result, Id } from '@bass-daw/schemas';
import { validateProject, serializeProject, deserializeProject, sha256Hex, SHA256_RE, uuid, nowIso } from '@bass-daw/schemas';
import { openDb, req, txDone } from './idb.ts';
import { type ByteStore, paths, hashBlob, chunksOf } from './bytestore.ts';

export type Hash = string;
export interface Revision {
  id: Id; projectId: Id; parentIds: Id[]; snapshotHash: Hash;
  assetHashes: Hash[]; editSequence: number; createdAt: string;
  /** 사용자 pin — GC 대상 제외 */
  pinned?: boolean;
}
export interface LocalHead { projectId: Id; revisionId: Id; writerEpoch: number }
export interface AssetEntry { hash: Hash; bytes: number; state: 'staging' | 'ready' | 'corrupt'; storage: 'opfs' | 'idb' | 'memory'; verifiedAt: string | null; createdAt?: string }
export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'degraded' | 'quota-error' | 'read-only';
/** 04 §5 SyncStatus.state */
export type SyncState = 'local-only' | 'idle' | 'queued' | 'uploading' | 'committing' | 'synced' | 'conflict' | 'auth-required' | 'offline' | 'error';
/** 사용자가 고른 클라우드 연결(최초 연결은 명시적 선택). ownerId 계정의 outbox 만 이 project 로 전송된다. */
export interface SyncLink { ownerId: string; linkedAt: string; lastSyncedRevision: Id | null; remoteDeleted?: boolean; lastError?: string | null }
export interface ProjectRecord {
  projectId: Id; head: Id | null; remoteHead: Id | null; syncStatus: SyncState;
  title: string; updatedAt: string; readOnlyReason?: string | null;
  sync?: SyncLink | null;
}
export interface RemoteCommitRequest { projectId: Id; revision: Omit<Revision, 'pinned'>; expectedRemoteHead: Id | null; idempotencyKey: Id }
/**
 * outbox(04 §6): 로컬 commit 과 같은 IDB transaction 에서 기록된다. request 는 첫 전송 직전에 고정되며
 * 이후 재시도는 같은 idempotencyKey·같은 payload 로만 한다(응답 유실 후에도 결과를 조회/재사용).
 */
export interface OutboxEntry {
  id: string; projectId: Id; ownerId: string; revisionId: Id; idempotencyKey: Id;
  state: 'queued' | 'sending' | 'conflict'; attempts: number; nextAt: number; createdAt: string;
  request: RemoteCommitRequest | null; lastError: string | null;
}
/** CAS 충돌: local head·remote head·공통 base 를 모두 보존(04 §6) */
export interface ConflictRecord {
  projectId: Id; ownerId: string; localRevision: Id; localHeadAtDetect: Id | null; remoteHead: Id | null; base: Id | null;
  retainedRevision: Id | null; remoteDeleted: boolean; detectedAt: string; entryId: string;
}
/** 보존된 로컬 분기(충돌에서 원격을 선택해도 삭제하지 않음) */
export interface LocalBranch { revisionId: Id; reason: 'conflict-local' | 'conflict-remote-copy'; at: string; note?: string }
interface LeaseRecord { projectId: Id; epoch: number; ownerId: string; expiresAt: number }
export interface OpenResult { project: Project; revision: Revision; missing: Hash[]; readOnly: boolean; diagnostics: string[] }

export const LEASE_TTL_MS = 10_000;
export const HEARTBEAT_MS = 3_000;

/** commit 단계 경계 장애 주입(L02). step 1..5 직전에 호출된다. */
export type FaultHook = (step: 1 | 2 | 3 | 4 | 5) => void | Promise<void>;

const fail = <T>(code: string, message: string, path = '$'): Result<T> => ({ ok: false, errors: [{ code, path, message }] });

export class LocalStore {
  readonly writerId = uuid();
  private epochs = new Map<Id, number>();
  faultHook: FaultHook | null = null;
  now: () => number = () => Date.now();

  private constructor(readonly db: IDBDatabase, readonly bytes: ByteStore) {}

  static async open(bytes: ByteStore, name = 'bass-daw', factory?: IDBFactory): Promise<LocalStore> {
    return new LocalStore(await openDb(name, factory), bytes);
  }

  close(): void { this.db.close(); }

  // ---------------- 프로젝트 목록 ----------------
  async listProjects(): Promise<ProjectRecord[]> {
    const all = await req(this.db.transaction('projects').objectStore('projects').getAll()) as ProjectRecord[];
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRecord(projectId: Id): Promise<ProjectRecord | undefined> {
    return req(this.db.transaction('projects').objectStore('projects').get(projectId));
  }

  // ---------------- writer lease / epoch fencing (04 §3 다중 탭) ----------------
  /**
   * lease 획득. 다른 writer 의 lease 가 남아 있으면 takeover 없이는 얻지 못한다.
   * - 유효한 lease → WRITER_HELD
   * - 만료된 lease(heartbeat 지연) → WRITER_UNRESPONSIVE: 응답 지연은 탭 종료의 증거가 아니다(throttling 된 탭일 수 있음).
   *   takeover 는 사용자의 명시적 선택이나 종료 증거(Web Lock 해제)가 있을 때만 호출자가 지정한다.
   *   released(expiresAt=0, 정상 종료)는 즉시 얻을 수 있다.
   * 어느 경우든 takeover 후 이전 writer 의 commit 은 epoch 검사로 거절된다.
   */
  async acquireLease(projectId: Id, opts: { takeover?: boolean } = {}): Promise<Result<{ epoch: number }>> {
    const tx = this.db.transaction('leases', 'readwrite');
    const os = tx.objectStore('leases');
    const cur = await req(os.get(projectId)) as LeaseRecord | undefined;
    const t = this.now();
    if (cur && cur.ownerId !== this.writerId && cur.expiresAt !== 0 && !opts.takeover) {
      tx.abort();
      return cur.expiresAt > t
        ? fail('WRITER_HELD', 'another tab holds the writer lease')
        : fail('WRITER_UNRESPONSIVE', 'the writer tab stopped renewing its lease (it may be throttled, not closed); take over explicitly to edit here');
    }
    const epoch = (cur?.epoch ?? 0) + (cur?.ownerId === this.writerId ? 0 : 1);
    os.put({ projectId, epoch, ownerId: this.writerId, expiresAt: t + LEASE_TTL_MS } satisfies LeaseRecord);
    await txDone(tx);
    this.epochs.set(projectId, epoch);
    return { ok: true, value: { epoch } };
  }

  /** heartbeat — 소유권을 잃었으면 WRITER_LOST */
  async heartbeat(projectId: Id): Promise<Result<void>> {
    const tx = this.db.transaction('leases', 'readwrite');
    const os = tx.objectStore('leases');
    const cur = await req(os.get(projectId)) as LeaseRecord | undefined;
    const mine = this.epochs.get(projectId);
    if (!cur || cur.ownerId !== this.writerId || cur.epoch !== mine) { tx.abort(); this.epochs.delete(projectId); return fail('WRITER_LOST', 'writer lease lost'); }
    os.put({ ...cur, expiresAt: this.now() + LEASE_TTL_MS });
    await txDone(tx);
    return { ok: true, value: undefined };
  }

  async releaseLease(projectId: Id): Promise<void> {
    const tx = this.db.transaction('leases', 'readwrite');
    const os = tx.objectStore('leases');
    const cur = await req(os.get(projectId)) as LeaseRecord | undefined;
    if (cur && cur.ownerId === this.writerId) os.put({ ...cur, expiresAt: 0 });
    await txDone(tx);
    this.epochs.delete(projectId);
  }

  hasLease(projectId: Id): boolean { return this.epochs.has(projectId); }

  // ---------------- 자산 import (04 §3 단계 2–3) ----------------
  async importAsset(data: Blob | Uint8Array, expectedHash?: Hash): Promise<Result<AssetEntry>> {
    const stagingId = uuid();
    const sp = paths.staging(stagingId);
    try {
      await this.faultHook?.(2);
      const w = await this.bytes.write(sp, data);
      // 닫힌 뒤 길이·hash 재검증
      const back = await this.bytes.read(sp);
      if (!back) return fail('ASSET_MISSING', 'staging file disappeared');
      const check = await hashBlob(back);
      if (check.hash !== w.hash || check.bytes !== w.bytes) { await this.bytes.remove(sp); return fail('HASH_MISMATCH', 'staging verify failed'); }
      if (expectedHash && expectedHash !== w.hash) { await this.bytes.remove(sp); return fail('HASH_MISMATCH', `expected ${expectedHash} got ${w.hash}`); }
      const existing = await this.getAssetEntry(w.hash);
      if (existing?.state === 'ready' && (await this.bytes.size(paths.asset(w.hash))) === w.bytes) {
        await this.bytes.remove(sp);
        return { ok: true, value: existing };
      }
      await this.faultHook?.(3);
      // promote: 원자적 rename 을 가정하지 않고 copy 후 최종 파일 재검증
      const ap = paths.asset(w.hash);
      await this.bytes.write(ap, back);
      const fin = await this.bytes.read(ap);
      const v = fin ? await hashBlob(fin) : null;
      if (!v || v.hash !== w.hash) { await this.bytes.remove(ap); await this.bytes.remove(sp); return fail('HASH_MISMATCH', 'promote verify failed'); }
      const entry: AssetEntry = { hash: w.hash, bytes: w.bytes, state: 'ready', storage: this.bytes.kind, verifiedAt: nowIso(new Date(this.now())), createdAt: nowIso(new Date(this.now())) };
      const tx = this.db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put(entry);
      await txDone(tx);
      await this.bytes.remove(sp);
      return { ok: true, value: entry };
    } catch (e) {
      try { await this.bytes.remove(sp); } catch { /* ignore */ }
      if ((e as DOMException)?.name === 'QuotaExceededError') return fail('QUOTA', 'storage quota exceeded');
      return fail('ASSET_IO', (e as Error).message);
    }
  }

  async getAssetEntry(hash: Hash): Promise<AssetEntry | undefined> {
    return req(this.db.transaction('assets').objectStore('assets').get(hash));
  }

  async readAsset(hash: Hash): Promise<Blob | null> {
    return this.bytes.read(paths.asset(hash));
  }

  // ---------------- commit (04 §3 단계 1–5) ----------------
  async commit(project: Project, expectedHead: Id | null, editSequence: number): Promise<Result<Revision>> {
    const projectId = project.id;
    const epoch = this.epochs.get(projectId);
    if (epoch === undefined) return fail('WRITER_LOST', 'no writer lease for project');
    await this.faultHook?.(1);
    // 4. validate + canonical serialization + snapshot hash (트랜잭션 밖)
    const v = validateProject(project);
    if (!v.ok) return v as Result<never>;
    const ser = serializeProject(project);
    if (!ser.ok) return ser as Result<never>;
    const snapshotHash = await sha256Hex(ser.value);
    const assetHashes = [...new Set(project.assets.map((a) => a.sha256))].sort();
    await this.faultHook?.(4);
    const rev: Revision = {
      id: uuid(), projectId, parentIds: expectedHead ? [expectedHead] : [], snapshotHash, assetHashes, editSequence,
      createdAt: nowIso(new Date(this.now())),
    };
    const tx = this.db.transaction(['projects', 'revisions', 'snapshots', 'assets', 'leases', 'outbox'], 'readwrite');
    const done = txDone(tx);
    try {
      const lease = await req(tx.objectStore('leases').get(projectId)) as LeaseRecord | undefined;
      if (!lease || lease.ownerId !== this.writerId || lease.epoch !== epoch) throw Object.assign(new Error('writer lease lost'), { code: 'WRITER_LOST' });
      const rec = await req(tx.objectStore('projects').get(projectId)) as ProjectRecord | undefined;
      if ((rec?.head ?? null) !== expectedHead) throw Object.assign(new Error(`head ${rec?.head} != expected ${expectedHead}`), { code: 'LOCAL_HEAD_CHANGED' });
      // 새 head 가 불완전 새 asset 을 참조하지 않게: ready 이거나 이전 head 가 이미 참조하던(degraded 보존) hash 만 허용
      let prevHashes = new Set<string>();
      if (rec?.head) {
        const prev = await req(tx.objectStore('revisions').get(rec.head)) as Revision | undefined;
        prevHashes = new Set(prev?.assetHashes ?? []);
      }
      for (const h of assetHashes) {
        const a = await req(tx.objectStore('assets').get(h)) as AssetEntry | undefined;
        if (a?.state !== 'ready' && !prevHashes.has(h)) throw Object.assign(new Error(`asset ${h} not ready`), { code: 'ASSET_NOT_READY' });
      }
      tx.objectStore('snapshots').put({ hash: snapshotHash, bytes: ser.value });
      tx.objectStore('revisions').put(rev);
      const sync = rec?.sync ?? null;
      if (sync) await this.enqueueInTx(tx, projectId, sync.ownerId, rev.id);
      tx.objectStore('projects').put({
        projectId, head: rev.id, remoteHead: rec?.remoteHead ?? null,
        syncStatus: !sync ? 'local-only' : rec?.syncStatus === 'conflict' ? 'conflict' : 'queued',
        title: project.title, updatedAt: project.updatedAt, readOnlyReason: null, sync,
      } satisfies ProjectRecord);
      if (this.faultHook) await Promise.resolve(this.faultHook(5)); // 트랜잭션 중 crash → abort
    } catch (e) {
      try { tx.abort(); } catch { /* already aborted */ }
      await done.catch(() => undefined);
      const code = (e as { code?: string }).code ?? ((e as DOMException).name === 'QuotaExceededError' ? 'QUOTA' : 'COMMIT_FAILED');
      return fail(code, (e as Error).message);
    }
    try { await done; } catch (e) {
      return fail((e as DOMException)?.name === 'QuotaExceededError' ? 'QUOTA' : 'COMMIT_FAILED', String((e as Error)?.message ?? e));
    }
    return { ok: true, value: rev };
  }

  // ---------------- open / recover (04 §4) ----------------
  async open(projectId: Id, revisionId?: Id): Promise<Result<OpenResult>> {
    const rec = await this.getRecord(projectId);
    if (!rec?.head) return fail('NOT_FOUND', 'project not found');
    const revId = revisionId ?? rec.head;
    const tx = this.db.transaction(['revisions', 'snapshots'], 'readonly');
    const rev = await req(tx.objectStore('revisions').get(revId)) as Revision | undefined;
    if (!rev) return fail('SNAPSHOT_CORRUPT', 'head revision missing');
    const snap = await req(tx.objectStore('snapshots').get(rev.snapshotHash)) as { hash: string; bytes: Uint8Array } | undefined;
    if (!snap) return fail('SNAPSHOT_CORRUPT', 'snapshot missing');
    const bytes = new Uint8Array(snap.bytes);
    if (await sha256Hex(bytes) !== rev.snapshotHash) return fail('SNAPSHOT_CORRUPT', 'snapshot hash mismatch — choose an earlier revision');
    const d = deserializeProject(bytes);
    if (!d.ok) {
      if (d.errors[0].code === 'FUTURE_VERSION') return fail('FUTURE_VERSION', d.errors[0].message);
      return fail('SNAPSHOT_CORRUPT', `snapshot invalid: ${d.errors[0].message}`);
    }
    const missing: Hash[] = [];
    const diagnostics: string[] = [];
    for (const a of d.value.assets) {
      const entry = await this.getAssetEntry(a.sha256);
      const size = await this.bytes.size(paths.asset(a.sha256));
      if (!entry || entry.state !== 'ready' || size !== a.byteLength) {
        if (!missing.includes(a.sha256)) missing.push(a.sha256);
        diagnostics.push(`ASSET_MISSING ${a.sha256}${size !== null && size !== a.byteLength ? ` (size ${size} != ${a.byteLength})` : ''}`);
      }
    }
    return { ok: true, value: { project: d.value, revision: rev, missing, readOnly: false, diagnostics } };
  }

  /** 열기 불가 시 직전 정상 revision 후보(최신순). 손상 snapshot 은 덮어쓰지 않는다. */
  async recover(projectId: Id): Promise<Result<(Revision & { valid: boolean })[]>> {
    const revs = await this.revisions(projectId);
    const out: (Revision & { valid: boolean })[] = [];
    for (const r of revs) {
      const snap = await req(this.db.transaction('snapshots').objectStore('snapshots').get(r.snapshotHash)) as { bytes: Uint8Array } | undefined;
      const valid = !!snap && (await sha256Hex(new Uint8Array(snap.bytes))) === r.snapshotHash && deserializeProject(new Uint8Array(snap.bytes)).ok;
      out.push({ ...r, valid });
    }
    return { ok: true, value: out };
  }

  async revisions(projectId: Id): Promise<Revision[]> {
    const all = await req(this.db.transaction('revisions').objectStore('revisions').index('projectId').getAll(projectId)) as Revision[];
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.editSequence - a.editSequence);
  }

  async pinRevision(revisionId: Id, pinned: boolean): Promise<void> {
    const tx = this.db.transaction('revisions', 'readwrite');
    const r = await req(tx.objectStore('revisions').get(revisionId)) as Revision | undefined;
    if (r) tx.objectStore('revisions').put({ ...r, pinned });
    await txDone(tx);
  }

  /** 손상 head 대신 이전 revision 을 새 head 로 되돌리는 명시적 작업(원본 revision 은 유지). */
  async restoreRevision(projectId: Id, revisionId: Id): Promise<Result<Revision>> {
    const o = await this.open(projectId, revisionId);
    if (!o.ok) return o as Result<never>;
    const rec = await this.getRecord(projectId);
    return this.commit({ ...o.value.project, updatedAt: nowIso(new Date(Math.max(this.now(), Date.parse(o.value.project.updatedAt)))) }, rec?.head ?? null, o.value.revision.editSequence);
  }

  async deleteProject(projectId: Id): Promise<void> {
    // 메타만 제거한다. revision/snapshot/asset 은 GC 가 reachability 로 정리한다.
    // 클라우드 사본은 건드리지 않는다(원격 삭제는 SyncEngine.deleteRemote 의 명시적 tombstone). 대기 outbox·충돌 기록만 정리.
    const tx = this.db.transaction(['projects', 'leases', 'outbox', 'meta'], 'readwrite');
    tx.objectStore('projects').delete(projectId);
    tx.objectStore('leases').delete(projectId);
    for (const e of await req(tx.objectStore('outbox').index('projectId').getAll(projectId)) as OutboxEntry[]) tx.objectStore('outbox').delete(e.id);
    tx.objectStore('meta').delete(`conflict:${projectId}`);
    await txDone(tx);
  }

  async snapshotBytes(hash: Hash): Promise<Uint8Array | null> {
    const s = await req(this.db.transaction('snapshots').objectStore('snapshots').get(hash)) as { bytes: Uint8Array } | undefined;
    return s ? new Uint8Array(s.bytes) : null;
  }

  // ---------------- 저장소 진단 ----------------
  async persist(): Promise<{ requested: boolean; persisted: boolean | null }> {
    try {
      const persisted = await navigator.storage?.persist?.();
      const tx = this.db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'persist', persisted: persisted ?? null, at: nowIso() });
      await txDone(tx);
      return { requested: true, persisted: persisted ?? null };
    } catch { return { requested: false, persisted: null }; }
  }

  // ---------------- 동기화 지원 (04 §5–6) ----------------
  /** commit transaction 안에서 outbox 기록. 한 번도 전송되지 않은 이전 queued 항목은 대체(coalesce)한다. */
  private async enqueueInTx(tx: IDBTransaction, projectId: Id, ownerId: string, revisionId: Id) {
    const os = tx.objectStore('outbox');
    const prev = await req(os.index('projectId').getAll(projectId)) as OutboxEntry[];
    for (const e of prev) if (e.state === 'queued' && e.attempts === 0 && !e.request && e.ownerId === ownerId) os.delete(e.id);
    os.put({ id: uuid(), projectId, ownerId, revisionId, idempotencyKey: uuid(), state: 'queued', attempts: 0, nextAt: 0, createdAt: nowIso(new Date(this.now())), request: null, lastError: null } satisfies OutboxEntry);
  }

  async outbox(projectId?: Id): Promise<OutboxEntry[]> {
    const os = this.db.transaction('outbox').objectStore('outbox');
    const all = await req(projectId ? os.index('projectId').getAll(projectId) : os.getAll()) as OutboxEntry[];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putOutbox(e: OutboxEntry): Promise<void> { const tx = this.db.transaction('outbox', 'readwrite'); tx.objectStore('outbox').put(e); await txDone(tx); }

  /** 사용자가 선택한 최초 연결: 현재 head 를 outbox 에 넣는다 */
  async linkProject(projectId: Id, ownerId: string): Promise<Result<ProjectRecord>> {
    const tx = this.db.transaction(['projects', 'outbox'], 'readwrite');
    const rec = await req(tx.objectStore('projects').get(projectId)) as ProjectRecord | undefined;
    if (!rec?.head) { tx.abort(); return fail('NOT_FOUND', 'project not found'); }
    if (rec.sync && rec.sync.ownerId !== ownerId) { tx.abort(); return fail('FORBIDDEN', `project is linked to another account (${rec.sync.ownerId})`); }
    const next: ProjectRecord = { ...rec, sync: rec.sync ?? { ownerId, linkedAt: nowIso(new Date(this.now())), lastSyncedRevision: null, lastError: null }, syncStatus: 'queued' };
    if (!rec.sync) await this.enqueueInTx(tx, projectId, ownerId, rec.head);
    tx.objectStore('projects').put(next);
    await txDone(tx);
    return { ok: true, value: next };
  }

  /** 연결 해제: 로컬 프로젝트는 그대로 두고 대기 outbox·충돌 기록만 정리한다(충돌 revision 은 분기로 pin) */
  async unlinkProject(projectId: Id): Promise<void> {
    const tx = this.db.transaction(['projects', 'outbox', 'meta', 'revisions'], 'readwrite');
    const rec = await req(tx.objectStore('projects').get(projectId)) as ProjectRecord | undefined;
    const c = await req(tx.objectStore('meta').get(`conflict:${projectId}`)) as { conflict: ConflictRecord } | undefined;
    if (c) await this.pinInTx(tx, c.conflict.localRevision);
    for (const e of await req(tx.objectStore('outbox').index('projectId').getAll(projectId)) as OutboxEntry[]) tx.objectStore('outbox').delete(e.id);
    tx.objectStore('meta').delete(`conflict:${projectId}`);
    if (rec) tx.objectStore('projects').put({ ...rec, sync: null, remoteHead: null, syncStatus: 'local-only' });
    await txDone(tx);
  }

  private async pinInTx(tx: IDBTransaction, revisionId: Id) {
    const r = await req(tx.objectStore('revisions').get(revisionId)) as Revision | undefined;
    if (r && !r.pinned) tx.objectStore('revisions').put({ ...r, pinned: true });
  }

  /** remote commit 성공 ack: remoteHead 갱신·outbox 제거를 한 transaction 에서. 이 commit 완료가 '동기화 성공'이다. */
  async applySyncAck(projectId: Id, entryId: string, remoteHead: Id, syncedRevision: Id): Promise<ProjectRecord | null> {
    const tx = this.db.transaction(['projects', 'outbox', 'meta'], 'readwrite');
    const rec = await req(tx.objectStore('projects').get(projectId)) as ProjectRecord | undefined;
    tx.objectStore('outbox').delete(entryId);
    const rest = (await req(tx.objectStore('outbox').index('projectId').getAll(projectId)) as OutboxEntry[]).filter((e) => e.id !== entryId);
    if (!rec?.sync) { await txDone(tx); return null; }
    const next: ProjectRecord = { ...rec, remoteHead, syncStatus: rest.length ? 'queued' : 'synced', sync: { ...rec.sync, lastSyncedRevision: syncedRevision, remoteDeleted: false, lastError: null } };
    tx.objectStore('projects').put(next);
    tx.objectStore('meta').delete(`conflict:${projectId}`);
    await txDone(tx);
    return next;
  }

  async recordConflict(c: ConflictRecord): Promise<void> {
    const tx = this.db.transaction(['projects', 'outbox', 'meta'], 'readwrite');
    const e = await req(tx.objectStore('outbox').get(c.entryId)) as OutboxEntry | undefined;
    if (e) tx.objectStore('outbox').put({ ...e, state: 'conflict', lastError: 'REMOTE_CONFLICT' });
    tx.objectStore('meta').put({ key: `conflict:${c.projectId}`, conflict: c });
    const rec = await req(tx.objectStore('projects').get(c.projectId)) as ProjectRecord | undefined;
    if (rec) tx.objectStore('projects').put({ ...rec, syncStatus: 'conflict' });
    await txDone(tx);
  }
  async conflict(projectId: Id): Promise<ConflictRecord | null> {
    const m = await req(this.db.transaction('meta').objectStore('meta').get(`conflict:${projectId}`)) as { conflict: ConflictRecord } | undefined;
    return m?.conflict ?? null;
  }
  async branches(projectId: Id): Promise<LocalBranch[]> {
    const m = await req(this.db.transaction('meta').objectStore('meta').get(`branches:${projectId}`)) as { branches: LocalBranch[] } | undefined;
    return m?.branches ?? [];
  }
  async addBranch(projectId: Id, b: LocalBranch): Promise<void> {
    const tx = this.db.transaction(['meta', 'revisions'], 'readwrite');
    const m = await req(tx.objectStore('meta').get(`branches:${projectId}`)) as { branches: LocalBranch[] } | undefined;
    const list = (m?.branches ?? []).filter((x) => x.revisionId !== b.revisionId);
    tx.objectStore('meta').put({ key: `branches:${projectId}`, branches: [...list, b] });
    await this.pinInTx(tx, b.revisionId);
    await txDone(tx);
  }

  /** 동기 상태 갱신(일시 상태 포함). head·revision 은 바꾸지 않는다. */
  async updateSync(projectId: Id, patch: { syncStatus?: SyncState; remoteHead?: Id | null; sync?: Partial<SyncLink> }): Promise<ProjectRecord | null> {
    const tx = this.db.transaction('projects', 'readwrite');
    const rec = await req(tx.objectStore('projects').get(projectId)) as ProjectRecord | undefined;
    if (!rec) { tx.abort(); return null; }
    const next: ProjectRecord = { ...rec, ...(patch.syncStatus ? { syncStatus: patch.syncStatus } : {}), ...('remoteHead' in patch ? { remoteHead: patch.remoteHead ?? null } : {}), sync: rec.sync && patch.sync ? { ...rec.sync, ...patch.sync } : rec.sync ?? null };
    tx.objectStore('projects').put(next);
    await txDone(tx);
    return next;
  }

  /**
   * 원격 revision 을 로컬 head 로 채택(다른 기기 복원·fast-forward·원격 사본 열기).
   * snapshot hash·02 검증·자산 ready 를 확인하고 lease epoch + head CAS 를 commit 과 같은 방식으로 검사한다.
   * revision id 는 원격과 같게 유지한다(remoteHead 대응). 대상 project 의 outbox·충돌 기록은 clearOutbox 일 때 정리한다.
   */
  async adoptRevision(rev: Revision, snapshot: Uint8Array, opts: { expectedHead: Id | null; remoteHead: Id; sync: SyncLink | null; clearOutbox?: boolean }): Promise<Result<Revision>> {
    const projectId = rev.projectId;
    const epoch = this.epochs.get(projectId);
    if (epoch === undefined) return fail('WRITER_LOST', 'no writer lease for project');
    if (await sha256Hex(snapshot) !== rev.snapshotHash) return fail('HASH_MISMATCH', 'remote snapshot hash mismatch');
    const d = deserializeProject(snapshot);
    if (!d.ok) return fail('SNAPSHOT_CORRUPT', d.errors[0].message);
    if (d.value.id !== projectId) return fail('SNAPSHOT_CORRUPT', 'snapshot belongs to another project');
    const want = [...new Set(d.value.assets.map((a) => a.sha256))].sort();
    if (want.join() !== [...new Set(rev.assetHashes)].sort().join()) return fail('HASH_MISMATCH', 'revision assetHashes differ from snapshot assets');
    const tx = this.db.transaction(['projects', 'revisions', 'snapshots', 'assets', 'leases', 'outbox', 'meta'], 'readwrite');
    const done = txDone(tx);
    try {
      const lease = await req(tx.objectStore('leases').get(projectId)) as LeaseRecord | undefined;
      if (!lease || lease.ownerId !== this.writerId || lease.epoch !== epoch) throw Object.assign(new Error('writer lease lost'), { code: 'WRITER_LOST' });
      const rec = await req(tx.objectStore('projects').get(projectId)) as ProjectRecord | undefined;
      if ((rec?.head ?? null) !== opts.expectedHead) throw Object.assign(new Error(`head ${rec?.head} != expected ${opts.expectedHead}`), { code: 'LOCAL_HEAD_CHANGED' });
      for (const h of want) {
        const a = await req(tx.objectStore('assets').get(h)) as AssetEntry | undefined;
        if (a?.state !== 'ready') throw Object.assign(new Error(`asset ${h} not ready`), { code: 'ASSET_NOT_READY' });
      }
      tx.objectStore('snapshots').put({ hash: rev.snapshotHash, bytes: snapshot });
      const { pinned: _p, ...plain } = rev;
      tx.objectStore('revisions').put(plain);
      if (opts.clearOutbox) {
        for (const e of await req(tx.objectStore('outbox').index('projectId').getAll(projectId)) as OutboxEntry[]) tx.objectStore('outbox').delete(e.id);
        tx.objectStore('meta').delete(`conflict:${projectId}`);
      }
      tx.objectStore('projects').put({
        projectId, head: rev.id, remoteHead: opts.remoteHead, syncStatus: opts.sync ? 'synced' : 'local-only',
        title: d.value.title, updatedAt: d.value.updatedAt, readOnlyReason: null, sync: opts.sync,
      } satisfies ProjectRecord);
    } catch (e) {
      try { tx.abort(); } catch { /* already aborted */ }
      await done.catch(() => undefined);
      return fail((e as { code?: string }).code ?? 'COMMIT_FAILED', (e as Error).message);
    }
    try { await done; } catch (e) { return fail('COMMIT_FAILED', String((e as Error)?.message ?? e)); }
    return { ok: true, value: rev };
  }

  async revision(id: Id): Promise<Revision | undefined> { return req(this.db.transaction('revisions').objectStore('revisions').get(id)); }

  // ---------------- GC (04 §4) ----------------
  async gc(opts: { now?: number; dryRun?: boolean; extraReachable?: Hash[] } = {}): Promise<{ revisions: Id[]; snapshots: Hash[]; assets: Hash[]; staging: string[]; cache: string[] }> {
    const now = opts.now ?? this.now();
    const projects = await this.listProjects();
    const allRevs = await req(this.db.transaction('revisions').objectStore('revisions').getAll()) as Revision[];
    const journals = await req(this.db.transaction('journals').objectStore('journals').getAll()) as { id: string; assetHashes?: Hash[]; segments?: string[]; state: string }[];
    const outbox = await req(this.db.transaction('outbox').objectStore('outbox').getAll()) as { revisionId?: Id }[];
    const keepRev = new Set<Id>();
    const live = new Set(projects.map((p) => p.projectId));
    for (const p of projects) {
      const revs = allRevs.filter((r) => r.projectId === p.projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      revs.slice(0, 100).forEach((r) => keepRev.add(r.id));
      const hours = new Set<string>();
      for (const r of revs) {
        const t = Date.parse(r.createdAt);
        if (now - t <= 24 * 3600_000) { const h = r.createdAt.slice(0, 13); if (!hours.has(h)) { hours.add(h); keepRev.add(r.id); } }
      }
      if (p.head) keepRev.add(p.head);
      if (p.remoteHead) keepRev.add(p.remoteHead);
    }
    for (const r of allRevs) if (r.pinned) keepRev.add(r.id);
    for (const o of outbox) if (o.revisionId) keepRev.add(o.revisionId);
    // 동기화 대기/충돌 revision 은 자동 삭제하지 않는다(04 §4): conflict 기록의 local/remote/base, 보존 분기
    const meta = await req(this.db.transaction('meta').objectStore('meta').getAll()) as { key: string; conflict?: ConflictRecord; branches?: LocalBranch[] }[];
    for (const m of meta) {
      if (m.conflict) for (const id of [m.conflict.localRevision, m.conflict.localHeadAtDetect, m.conflict.remoteHead, m.conflict.base, m.conflict.retainedRevision]) if (id) keepRev.add(id);
      for (const b of m.branches ?? []) keepRev.add(b.revisionId);
    }
    // 삭제된 프로젝트 revision 도 7일 유예
    for (const r of allRevs) if (!live.has(r.projectId) && now - Date.parse(r.createdAt) < 7 * 24 * 3600_000) keepRev.add(r.id);
    const keptRevs = allRevs.filter((r) => keepRev.has(r.id));
    const keepSnap = new Set(keptRevs.map((r) => r.snapshotHash));
    const keepAsset = new Set<Hash>([...keptRevs.flatMap((r) => r.assetHashes), ...(opts.extraReachable ?? [])]);
    for (const j of journals) for (const h of j.assetHashes ?? []) keepAsset.add(h);
    const keepSegments = new Set(journals.filter((j) => j.state !== 'committed').flatMap((j) => j.segments ?? []));

    const delRevs = allRevs.filter((r) => !keepRev.has(r.id)).map((r) => r.id);
    const allSnaps = await req(this.db.transaction('snapshots').objectStore('snapshots').getAllKeys()) as Hash[];
    const delSnaps = allSnaps.filter((h) => !keepSnap.has(h));
    const assets = await req(this.db.transaction('assets').objectStore('assets').getAll()) as AssetEntry[];
    const delAssets = assets.filter((a) => !keepAsset.has(a.hash) && now - Date.parse(a.createdAt ?? a.verifiedAt ?? new Date(0).toISOString()) > 7 * 24 * 3600_000).map((a) => a.hash);
    const staging = (await this.bytes.list('staging/')).filter((s) => !keepSegments.has(s));
    const cache = [...await this.bytes.list('cache/pcm/'), ...await this.bytes.list('cache/waveforms/')];
    if (!opts.dryRun) {
      const tx = this.db.transaction(['revisions', 'snapshots', 'assets'], 'readwrite');
      delRevs.forEach((id) => tx.objectStore('revisions').delete(id));
      delSnaps.forEach((h) => tx.objectStore('snapshots').delete(h));
      delAssets.forEach((h) => tx.objectStore('assets').delete(h));
      await txDone(tx);
      for (const h of delAssets) await this.bytes.remove(paths.asset(h));
      // staging orphan 은 24시간 유예: 생성 시각을 알 수 없는 어댑터에서는 이번 세션 외 파일만 삭제한다.
      for (const s of staging) if (!this.activeStaging.has(s)) await this.bytes.remove(s);
    }
    return { revisions: delRevs, snapshots: delSnaps, assets: delAssets, staging, cache };
  }

  /** 재생성 가능한 캐시 정리(quota 대응 첫 단계). source 파일은 지우지 않는다. */
  async clearCaches(): Promise<number> {
    const files = [...await this.bytes.list('cache/pcm/'), ...await this.bytes.list('cache/waveforms/')];
    for (const f of files) await this.bytes.remove(f);
    return files.length;
  }

  activeStaging = new Set<string>();

  // ---------------- 범용 journal (녹음/import 진행) ----------------
  async putJournal(j: { id: string; projectId: Id; kind: string; state: string; [k: string]: unknown }): Promise<void> {
    const tx = this.db.transaction('journals', 'readwrite');
    tx.objectStore('journals').put(j);
    await txDone(tx);
  }
  async journals(projectId?: Id): Promise<{ id: string; projectId: Id; kind: string; state: string; [k: string]: unknown }[]> {
    const os = this.db.transaction('journals').objectStore('journals');
    return req(projectId ? os.index('projectId').getAll(projectId) : os.getAll()) as Promise<never>;
  }
  async deleteJournal(id: string): Promise<void> {
    const tx = this.db.transaction('journals', 'readwrite');
    tx.objectStore('journals').delete(id);
    await txDone(tx);
  }
}

export { chunksOf, SHA256_RE };
