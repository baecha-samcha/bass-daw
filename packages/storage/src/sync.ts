// 04 §5–6 동기화 엔진(클라이언트). 네트워크는 주입된 RemoteApi 로만 접근한다(이 패키지는 fetch 를 import 하지 않는다).
// 순서: outbox(로컬 commit 과 같은 IDB tx) → 업로드(chunk 단위, 재개 가능) → 서버 검증 ready → remote commit(CAS)
//       → 로컬 ack transaction. ack 전 crash/단절이면 같은 idempotencyKey·같은 payload 로 재시도해 결과를 재사용한다.
// 충돌은 last-write-wins·자동 병합 없이 local/remote/base 를 보존하고 사용자 선택을 기다린다.
import type { Id, Result } from '@bass-daw/schemas';
import { Sha256, deserializeProject, serializeProject, uuid, nowIso } from '@bass-daw/schemas';
import type { LocalStore, OutboxEntry, ProjectRecord, Revision, RemoteCommitRequest, SyncState, ConflictRecord, SyncLink } from './local-store.ts';

// ---------------- API 계약 ----------------
export type ApiResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; code: string; message: string; retryAfterMs?: number; body?: Record<string, unknown> };
export interface RemoteConfig { chunkBytes: number; maxAssetBytes: number; maxSnapshotBytes: number; urlTtlSec: number; authMode: string }
export type RemoteRevision = Omit<Revision, 'pinned'> & { kind?: string };
export interface RemoteProjectInfo { id: Id; head: Id | null; tombstoned: boolean; deletedAt: string | null; purgeAfter: string | null; updatedAt: string }
export interface UploadChunk { n: number; bytes: number; url: string; expiresAt: number }
export type RemoteCommitResponse =
  | { status: 'committed'; remoteHead: Id }
  | { status: 'conflict'; remoteHead: Id | null; retainedRevision: Id | null; remoteDeleted?: boolean };
export interface RemoteApi {
  config(): Promise<ApiResult<RemoteConfig>>;
  listProjects(cursor?: string): Promise<ApiResult<{ projects: RemoteProjectInfo[]; next: string | null }>>;
  head(projectId: Id): Promise<ApiResult<{ head: Id | null; tombstoned: boolean; revision: RemoteRevision | null }>>;
  createUpload(projectId: Id, body: { kind: 'asset' | 'snapshot'; hash: string; bytes: number; chunkBytes: number; chunkHashes: string[] }): Promise<ApiResult<{ state: string; uploadId?: string; chunks?: UploadChunk[] }>>;
  uploadStatus(projectId: Id, uploadId: string): Promise<ApiResult<{ state: string; received: number[]; chunks: UploadChunk[]; verifiedBytes: number }>>;
  putChunk(url: string, bytes: Uint8Array): Promise<ApiResult<unknown>>;
  completeUpload(projectId: Id, uploadId: string): Promise<ApiResult<{ state: string; verifiedBytes?: number }>>;
  commit(projectId: Id, req: RemoteCommitRequest): Promise<ApiResult<RemoteCommitResponse>>;
  retainBranch(projectId: Id, body: { revision: RemoteRevision; idempotencyKey: Id }): Promise<ApiResult<{ status: string; revisionId: Id }>>;
  revision(projectId: Id, revisionId: Id): Promise<ApiResult<{ revision: RemoteRevision; urls: { snapshot: string; assets: Record<string, string> } }>>;
  download(url: string): Promise<ApiResult<Uint8Array>>;
  deleteProject(projectId: Id, body: { expectedRemoteHead: Id; idempotencyKey: Id }): Promise<ApiResult<{ status: string; remoteHead: Id | null }>>;
  restore(projectId: Id, body: { expectedRemoteHead: Id; revisionId: Id; idempotencyKey: Id }): Promise<ApiResult<{ status: string; remoteHead: Id | null }>>;
}

export interface SyncSession { ownerId: string }
export type SyncFaultStage = 'before-upload' | 'after-upload' | 'before-commit' | 'after-commit-response' | 'after-ack';
export interface SyncStatus { state: SyncState; localHead: Id | null; remoteHead: Id | null; pendingBytes: number; error: string | null; remoteDeleted: boolean; ownerId: string | null }

/** 1/2/4/8/16/30/60초 상한 + jitter(±20%) */
export const BACKOFF_S = [1, 2, 4, 8, 16, 30, 60];
export function backoffMs(attempt: number, rnd: number): number {
  const base = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000;
  return Math.round(base * (0.8 + 0.4 * rnd));
}

export class SyncError extends Error { constructor(readonly code: string, message: string, readonly retryAfterMs?: number, readonly status = 0) { super(`${code}: ${message}`); } }

/**
 * 업로드 전 해시: 전체 SHA-256 + chunk 별 SHA-256. bounded streaming(한 번에 chunk 하나만 메모리에),
 * signal 로 취소. 웹 앱은 전용 Web Worker 구현(apps/web/src/sync/hasher.ts)을 주입한다.
 */
export type ObjectHasher = (data: Blob | Uint8Array, chunkBytes: number, signal?: AbortSignal) => Promise<{ hash: string; chunkHashes: string[] }>;

export class HashCancelled extends Error { constructor() { super('CANCELLED: hashing cancelled'); } }

/** 기본(같은 스레드) 구현 — Node 테스트·Worker 내부용. */
export const streamHasher: ObjectHasher = async (data, chunkBytes, signal) => {
  const size = data instanceof Blob ? data.size : data.length;
  const full = new Sha256(); const chunkHashes: string[] = [];
  for (let o = 0; o < size || (size === 0 && o === 0); o += chunkBytes) {
    if (signal?.aborted) throw new HashCancelled();
    const end = Math.min(size, o + chunkBytes);
    const b = data instanceof Blob ? new Uint8Array(await data.slice(o, end).arrayBuffer()) : data.subarray(o, end);
    full.update(b); chunkHashes.push(await sha256hex(b));
    if (size === 0) break;
  }
  return { hash: full.digestHex(), chunkHashes };
};

export interface SyncEngineOptions {
  /** 업로드 해시 구현(기본 streamHasher). 웹은 Web Worker 구현을 주입한다. */
  hasher?: ObjectHasher;
  now?: () => number;
  random?: () => number;
  /** 재생·녹음 중이면 true → 대형 업로드를 chunk 사이에서 일시 정지하고 동시성 1 */
  isBusy?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  faultHook?: (stage: SyncFaultStage, projectId: Id) => void | Promise<void>;
  onChange?: (projectId: Id, s: SyncStatus) => void;
  /** fast-forward 가능 여부(열린 세션에 미저장 편집이 있으면 false) */
  canReplaceLocal?: (projectId: Id) => boolean;
  /** fast-forward/원격 채택 후 열린 세션을 다시 열도록 알림 */
  onLocalReplaced?: (projectId: Id) => void;
  /** false 면 백그라운드 타이머를 쓰지 않는다(테스트에서 syncAll 을 직접 호출) */
  autoKick?: boolean;
}

const isTransient = (r: { status: number; code: string }) => r.status === 0 || r.status >= 500 || r.status === 429 || r.code === 'NETWORK';

export class SyncEngine {
  private session: SyncSession | null = null;
  private cfg: RemoteConfig | null = null;
  private transient = new Map<Id, { state: SyncState; pendingBytes: number; error: string | null }>();
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly now: () => number; readonly random: () => number;
  constructor(readonly store: LocalStore, readonly api: RemoteApi, private opts: SyncEngineOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  // ---------------- session ----------------
  /** 로그인/로그아웃/계정 전환. 로그아웃은 로컬 프로젝트·outbox 를 지우지 않는다. 다른 계정 outbox 는 전송하지 않는다. */
  setSession(s: SyncSession | null) { this.session = s; this.cfg = null; void this.emitAll(); }
  get ownerId() { return this.session?.ownerId ?? null; }

  async status(projectId: Id): Promise<SyncStatus> {
    const rec = await this.store.getRecord(projectId);
    const t = this.transient.get(projectId);
    const owner = rec?.sync?.ownerId ?? null;
    let state: SyncState;
    if (!rec?.sync) state = 'local-only';
    else if (rec.syncStatus === 'conflict') state = 'conflict';
    else if (!this.session || this.session.ownerId !== owner) state = 'auth-required'; // 로그아웃·다른 계정: 전송하지 않음
    else state = t?.state ?? rec.syncStatus;
    return { state, localHead: rec?.head ?? null, remoteHead: rec?.remoteHead ?? null, pendingBytes: t?.pendingBytes ?? 0, error: t?.error ?? rec?.sync?.lastError ?? null, remoteDeleted: !!rec?.sync?.remoteDeleted, ownerId: owner };
  }
  private async emit(projectId: Id) { this.opts.onChange?.(projectId, await this.status(projectId)); }
  private async emitAll() { for (const r of await this.store.listProjects()) if (r.sync) await this.emit(r.projectId); }
  private async setTransient(projectId: Id, state: SyncState | null, extra: { pendingBytes?: number; error?: string | null } = {}) {
    if (state === null) this.transient.delete(projectId);
    else this.transient.set(projectId, { state, pendingBytes: extra.pendingBytes ?? 0, error: extra.error ?? null });
    await this.emit(projectId);
  }

  private needSession(): SyncSession { if (!this.session) throw new SyncError('AUTH_REQUIRED', 'login required'); return this.session; }
  private async config(): Promise<RemoteConfig> {
    if (this.cfg) return this.cfg;
    const r = await this.api.config();
    if (!r.ok) throw new SyncError(r.code, r.message, r.retryAfterMs, r.status);
    return (this.cfg = r.value);
  }
  private unwrap<T>(r: ApiResult<T>): T { if (!r.ok) throw new SyncError(r.code, r.message, r.retryAfterMs, r.status); return r.value; }

  // ---------------- link / list / clone ----------------
  /** 로컬 프로젝트의 최초 업로드 연결은 사용자가 선택한다 */
  async link(projectId: Id): Promise<Result<ProjectRecord>> {
    const s = this.needSession();
    const r = await this.store.linkProject(projectId, s.ownerId);
    await this.emit(projectId);
    if (r.ok) this.kick();
    return r;
  }
  async unlink(projectId: Id) { await this.store.unlinkProject(projectId); this.transient.delete(projectId); await this.emit(projectId); }

  async remoteProjects(): Promise<RemoteProjectInfo[]> {
    this.needSession();
    const out: RemoteProjectInfo[] = []; let cursor: string | undefined;
    do { const r = this.unwrap(await this.api.listProjects(cursor)); out.push(...r.projects); cursor = r.next ?? undefined; } while (cursor);
    return out;
  }

  /** 원격 revision 의 snapshot·자산을 받아 로컬에 준비(자산은 hash 검증 후 import) */
  private async fetchRevision(projectId: Id, revisionId: Id): Promise<{ rev: Revision; snapshot: Uint8Array }> {
    const m = this.unwrap(await this.api.revision(projectId, revisionId));
    for (const h of m.revision.assetHashes) {
      const e = await this.store.getAssetEntry(h);
      if (e?.state === 'ready') continue;
      const bytes = await this.download(projectId, revisionId, m.urls.assets[h], 'asset', h);
      const imp = await this.store.importAsset(bytes, h); // 내용 hash 재검증 후 ready
      if (!imp.ok) throw new SyncError(imp.errors[0].code, imp.errors[0].message);
    }
    const snapshot = await this.download(projectId, revisionId, m.urls.snapshot, 'snapshot', m.revision.snapshotHash);
    const { kind: _k, ...rev } = m.revision;
    return { rev: rev as Revision, snapshot };
  }
  /** 만료된 read URL 은 manifest 를 다시 받아 한 번 재시도 */
  private async download(projectId: Id, revisionId: Id, url: string, kind: 'asset' | 'snapshot', hash: string): Promise<Uint8Array> {
    let r = await this.api.download(url);
    if (!r.ok && r.code === 'UPLOAD_EXPIRED') {
      const m = this.unwrap(await this.api.revision(projectId, revisionId));
      r = await this.api.download(kind === 'snapshot' ? m.urls.snapshot : m.urls.assets[hash]);
    }
    return this.unwrap(r);
  }

  /** 다른 기기 복원: 원격 head 를 새 로컬 프로젝트(같은 id)로 받는다 */
  async clone(projectId: Id): Promise<Result<Revision>> {
    const s = this.needSession();
    if (await this.store.getRecord(projectId)) return { ok: false, errors: [{ code: 'EXISTS', path: '$', message: 'project already exists on this device' }] };
    const h = this.unwrap(await this.api.head(projectId));
    if (!h.head || h.tombstoned) return { ok: false, errors: [{ code: h.tombstoned ? 'PROJECT_DELETED' : 'NOT_FOUND', path: '$', message: 'remote project has no restorable head' }] };
    const { rev, snapshot } = await this.fetchRevision(projectId, h.head);
    const lease = await this.store.acquireLease(projectId);
    if (!lease.ok) return lease as Result<never>;
    try {
      return await this.store.adoptRevision(rev, snapshot, { expectedHead: null, remoteHead: h.head, sync: { ownerId: s.ownerId, linkedAt: nowIso(new Date(this.now())), lastSyncedRevision: h.head, lastError: null } });
    } finally { await this.store.releaseLease(projectId); await this.emit(projectId); }
  }

  /**
   * 원격 변경 확인. 로컬이 깨끗하면(마지막 동기화 이후 로컬 commit·outbox 없음) fast-forward, 아니면 push 에서 CAS 충돌로 처리.
   * 원격 삭제(tombstone)는 표시만 하고 로컬을 자동 삭제하지 않는다.
   */
  async pull(projectId: Id): Promise<'unchanged' | 'fast-forward' | 'remote-deleted' | 'local-ahead' | 'busy'> {
    const s = this.needSession();
    const rec = await this.store.getRecord(projectId);
    if (!rec?.sync || rec.sync.ownerId !== s.ownerId) return 'unchanged';
    const h = this.unwrap(await this.api.head(projectId));
    if (h.tombstoned) {
      if (!rec.sync.remoteDeleted) await this.store.updateSync(projectId, { sync: { remoteDeleted: true } });
      await this.emit(projectId); return 'remote-deleted';
    }
    if (!h.head || h.head === rec.remoteHead) return 'unchanged';
    const clean = rec.head === rec.sync.lastSyncedRevision && (await this.store.outbox(projectId)).length === 0;
    if (!clean) return 'local-ahead';
    if (this.opts.canReplaceLocal && !this.opts.canReplaceLocal(projectId)) return 'busy';
    const r = await this.adoptRemote(projectId, h.head, rec.head, rec.sync, false);
    return r.ok ? 'fast-forward' : 'busy';
  }

  private async adoptRemote(projectId: Id, remoteHead: Id, expectedLocal: Id | null, link: SyncLink, clearOutbox: boolean): Promise<Result<Revision>> {
    const { rev, snapshot } = await this.fetchRevision(projectId, remoteHead);
    const held = this.store.hasLease(projectId);
    if (!held) { const l = await this.store.acquireLease(projectId); if (!l.ok) return l as Result<never>; }
    try {
      const r = await this.store.adoptRevision(rev, snapshot, { expectedHead: expectedLocal, remoteHead, sync: { ...link, lastSyncedRevision: remoteHead, remoteDeleted: false, lastError: null }, clearOutbox });
      if (r.ok) this.opts.onLocalReplaced?.(projectId);
      return r;
    } finally { if (!held) await this.store.releaseLease(projectId); await this.emit(projectId); }
  }

  // ---------------- push ----------------
  /** 백그라운드 처리 예약 */
  kick(delay = 0) {
    if (this.opts.autoKick === false) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.syncAll().catch(() => undefined); }, delay);
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** 진행 중인 해시·업로드를 취소한다(outbox 는 그대로, 다음 sync 에서 재개) */
  cancel() { this.abort?.abort(); }

  /** 현재 계정의 due outbox 를 모두 처리. force 면 backoff 시각을 무시(테스트·수동 "지금 동기화"). */
  async syncAll(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) { await this.running; return; }
    this.abort = new AbortController();
    this.running = (async () => {
      const s = this.session;
      const entries = await this.store.outbox();
      const byProject = new Map<Id, OutboxEntry[]>();
      for (const e of entries) byProject.set(e.projectId, [...(byProject.get(e.projectId) ?? []), e]);
      let nextDue = Infinity;
      for (const [projectId, list] of byProject) {
        const rec = await this.store.getRecord(projectId);
        if (!rec) { continue; }
        if (!s || !rec.sync || rec.sync.ownerId !== s.ownerId) { await this.emit(projectId); continue; } // 다른 계정 outbox 는 보내지 않는다
        if (list.some((e) => e.state === 'conflict')) continue; // 사용자 해결 대기
        for (const e of list) {
          if (e.ownerId !== s.ownerId) continue;
          if (!opts.force && e.nextAt > this.now()) { nextDue = Math.min(nextDue, e.nextAt); break; }
          const r = await this.pushEntry(e);
          if (r === 'cancelled') return; // 취소: 자동 재시작 예약 없음
          if (r === 'retry') { const x = (await this.store.outbox(projectId)).find((y) => y.id === e.id); if (x) nextDue = Math.min(nextDue, x.nextAt); break; }
          if (r !== 'done') break; // conflict/auth/error: 이 project 의 뒤 항목은 멈춤
        }
      }
      if (Number.isFinite(nextDue)) this.kick(Math.max(0, nextDue - this.now()));
    })();
    try { await this.running; } finally { this.running = null; this.abort = null; }
  }

  /** 한 outbox 항목 처리 */
  async pushEntry(e0: OutboxEntry): Promise<'done' | 'conflict' | 'retry' | 'auth' | 'error' | 'cancelled'> {
    const projectId = e0.projectId;
    let e = e0;
    let acked = false;
    try {
      const s = this.needSession();
      if (e.ownerId !== s.ownerId) throw new SyncError('FORBIDDEN', 'entry belongs to another account');
      const rec = await this.store.getRecord(projectId);
      if (!rec?.sync) throw new SyncError('NOT_LINKED', 'project is not linked');
      const local = await this.store.revision(e.revisionId);
      if (!local) throw new SyncError('ASSET_MISSING', `local revision ${e.revisionId} missing`);
      // 첫 전송 전에 payload 고정(이후 재시도는 동일 payload + 동일 key)
      if (!e.request) {
        const { pinned: _p, ...plain } = local;
        const expected = rec.remoteHead;
        e = { ...e, state: 'sending', request: { projectId, revision: { ...plain, parentIds: expected ? [expected] : [] }, expectedRemoteHead: expected, idempotencyKey: e.idempotencyKey } };
        await this.store.putOutbox(e);
      }
      const req = e.request!;
      await this.opts.faultHook?.('before-upload', projectId);
      await this.uploadRevision(projectId, req.revision);
      await this.opts.faultHook?.('after-upload', projectId);
      await this.setTransient(projectId, 'committing');
      await this.opts.faultHook?.('before-commit', projectId);
      let res = await this.api.commit(projectId, req);
      if (!res.ok && res.code === 'REF_NOT_READY') { // 서버에서 객체가 정리됐거나 미완료 → 다시 업로드 후 1회 재시도
        await this.uploadRevision(projectId, req.revision);
        res = await this.api.commit(projectId, req);
      }
      const out = this.unwrap(res);
      await this.opts.faultHook?.('after-commit-response', projectId);
      if (out.status === 'committed') {
        await this.store.applySyncAck(projectId, e.id, out.remoteHead, req.revision.id);
        acked = true;
        await this.opts.faultHook?.('after-ack', projectId);
        await this.setTransient(projectId, null);
        return 'done';
      }
      const c: ConflictRecord = { projectId, ownerId: s.ownerId, localRevision: req.revision.id, localHeadAtDetect: rec.head, remoteHead: out.remoteHead, base: req.expectedRemoteHead, retainedRevision: out.retainedRevision, remoteDeleted: !!out.remoteDeleted, detectedAt: nowIso(new Date(this.now())), entryId: e.id };
      await this.store.recordConflict(c);
      await this.setTransient(projectId, null);
      return 'conflict';
    } catch (err) {
      if (acked) { await this.setTransient(projectId, null); return 'done'; } // ack 이후 실패: 이미 동기화 완료(outbox 재기록 금지)
      const x = err instanceof SyncError ? err : new SyncError('NETWORK', String((err as Error)?.message ?? err));
      if (x.code === 'CANCELLED') { await this.setTransient(projectId, 'queued', { error: 'cancelled' }); return 'cancelled'; } // backoff 없이 다음 sync 까지 대기
      if (x.code === 'AUTH_REQUIRED' || x.status === 401) { await this.setTransient(projectId, 'auth-required', { error: x.message }); return 'auth'; }
      if (isTransient({ status: x.status, code: x.code })) {
        const attempts = e.attempts + 1;
        const wait = x.retryAfterMs ?? backoffMs(e.attempts, this.random()); // 429 는 Retry-After 를 따른다
        await this.store.putOutbox({ ...e, attempts, nextAt: this.now() + wait, lastError: x.message });
        await this.setTransient(projectId, x.status === 0 || x.code === 'NETWORK' ? 'offline' : 'queued', { error: x.message });
        return 'retry';
      }
      await this.store.putOutbox({ ...e, lastError: x.message });
      await this.store.updateSync(projectId, { sync: { lastError: x.message } });
      await this.setTransient(projectId, 'error', { error: x.message });
      return 'error';
    }
  }

  /** snapshot + 참조 자산을 업로드하고 서버 검증(ready)까지 기다린다. 로컬 원본은 읽기만 한다. */
  private async uploadRevision(projectId: Id, rev: RemoteRevision) {
    const snap = await this.store.snapshotBytes(rev.snapshotHash);
    if (!snap) throw new SyncError('ASSET_MISSING', 'local snapshot missing');
    const items: { kind: 'asset' | 'snapshot'; hash: string; read: () => Promise<Blob | Uint8Array | null> }[] = [
      ...rev.assetHashes.map((h) => ({ kind: 'asset' as const, hash: h, read: () => this.store.readAsset(h) })),
      { kind: 'snapshot', hash: rev.snapshotHash, read: async () => snap },
    ];
    let pending = 0;
    for (const it of items) pending += (await it.read().then((b) => (b instanceof Blob ? b.size : b?.length ?? 0)));
    await this.setTransient(projectId, 'uploading', { pendingBytes: pending });
    for (const it of items) {
      const data = await it.read();
      if (!data) throw new SyncError('ASSET_MISSING', `${it.kind} ${it.hash} missing locally`);
      const n = await this.uploadObject(projectId, it.kind, it.hash, data);
      pending -= n;
      await this.setTransient(projectId, 'uploading', { pendingBytes: Math.max(0, pending) });
    }
  }

  private async readRange(data: Blob | Uint8Array, start: number, end: number): Promise<Uint8Array> {
    return data instanceof Blob ? new Uint8Array(await data.slice(start, end).arrayBuffer()) : data.subarray(start, end);
  }

  /** chunk hash + 전체 hash 계산 → upload intent → 누락 chunk 만 PUT(재개) → complete(서버 검증 job 재개 포함) */
  private async uploadObject(projectId: Id, kind: 'asset' | 'snapshot', hash: string, data: Blob | Uint8Array): Promise<number> {
    const cfg = await this.config();
    const size = data instanceof Blob ? data.size : data.length;
    const signal = this.abort?.signal;
    let digest: { hash: string; chunkHashes: string[] };
    try { digest = await (this.opts.hasher ?? streamHasher)(data, cfg.chunkBytes, signal); }
    catch (e) {
      if (e instanceof HashCancelled || signal?.aborted) throw new SyncError('CANCELLED', 'upload cancelled');
      throw new SyncError('NETWORK', `hashing failed (retryable): ${(e as Error)?.message ?? e}`);
    }
    const chunkHashes = digest.chunkHashes;
    // 로컬 원본이 손상됐으면 업로드하지 않는다(원본은 삭제하지 않음)
    if (digest.hash !== hash) throw new SyncError('ASSET_CORRUPT', `local ${kind} ${hash.slice(0, 12)}… does not match its hash`);
    let intent = this.unwrap(await this.api.createUpload(projectId, { kind, hash, bytes: size, chunkBytes: cfg.chunkBytes, chunkHashes }));
    if (intent.state === 'ready') return size;
    const uploadId = intent.uploadId!;
    let chunks = intent.chunks ?? [];
    for (let round = 0; round < 3 && chunks.length; round++) {
      const queue = [...chunks]; let expired = false;
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          if (this.abort?.signal.aborted) throw new SyncError('CANCELLED', 'upload cancelled');
          while (this.opts.isBusy?.()) await (this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(250); // 재생/녹음 중 일시 정지
          const b = await this.readRange(data, c.n * cfg.chunkBytes, c.n * cfg.chunkBytes + c.bytes);
          const r = await this.api.putChunk(c.url, b);
          if (!r.ok && r.code === 'UPLOAD_EXPIRED') { expired = true; continue; }
          this.unwrap(r);
        }
      };
      await Promise.all(Array.from({ length: this.opts.isBusy?.() ? 1 : 2 }, worker)); // 동시 upload 2, 재생 중 1
      const st = this.unwrap(await this.api.uploadStatus(projectId, uploadId));
      if (st.state === 'expired') { intent = this.unwrap(await this.api.createUpload(projectId, { kind, hash, bytes: size, chunkBytes: cfg.chunkBytes, chunkHashes })); if (intent.state === 'ready') return size; chunks = intent.chunks ?? []; continue; }
      chunks = st.chunks; // 만료 URL 은 새로 발급된 URL 로 재시도
      if (!expired && chunks.length === 0) break;
    }
    if (chunks.length) throw new SyncError('UPLOAD_EXPIRED', 'chunks could not be uploaded before URL expiry');
    for (let i = 0; i < 10_000; i++) {
      const r = this.unwrap(await this.api.completeUpload(projectId, uploadId));
      if (r.state === 'ready') return size;
      // verifying: 서버의 bounded incremental hash job 을 같은 호출로 재개
    }
    throw new SyncError('UPLOAD_INCOMPLETE', 'server verification did not finish');
  }

  // ---------------- 충돌 해결 (사용자 선택만) ----------------
  /** (1) 로컬 분기를 새 로컬 프로젝트로 저장 → 원래 프로젝트는 원격 head 로. 새 id 를 돌려준다. */
  async keepLocalAsNewProject(projectId: Id, title?: string): Promise<Result<{ newProjectId: Id }>> {
    const c = await this.store.conflict(projectId);
    if (!c) return { ok: false, errors: [{ code: 'NO_CONFLICT', path: '$', message: 'no conflict' }] };
    const rec = (await this.store.getRecord(projectId))!;
    const copy = await this.copyRevisionAsNewProject(rec.head!, title ?? `${rec.title} (로컬 분기)`, { originProjectId: projectId, conflictBranchOf: c.localRevision });
    if (!copy.ok) return copy;
    if (!c.remoteDeleted && c.remoteHead) {
      const r = await this.openRemote(projectId);
      if (!r.ok) return r as Result<never>;
    }
    return copy;
  }

  /** (2) 원격 사본 열기: 이 프로젝트를 원격 head 로 바꾼다. 로컬 분기 revision 은 pin + 분기 목록에 보존(삭제하지 않음). */
  async openRemote(projectId: Id): Promise<Result<Revision>> {
    const c = await this.store.conflict(projectId);
    const rec = await this.store.getRecord(projectId);
    if (!c || !rec?.sync || !c.remoteHead) return { ok: false, errors: [{ code: 'NO_CONFLICT', path: '$', message: 'no remote head to open' }] };
    if (c.remoteDeleted) return { ok: false, errors: [{ code: 'PROJECT_DELETED', path: '$', message: 'remote copy was deleted; restore it or keep local only' }] };
    for (const id of new Set([c.localRevision, rec.head!])) await this.store.addBranch(projectId, { revisionId: id, reason: 'conflict-local', at: nowIso(new Date(this.now())) });
    return this.adoptRemote(projectId, c.remoteHead, rec.head, rec.sync, true);
  }

  /** (3) 수동 비교용: 원격 head 를 별도 로컬 프로젝트(연결 안 됨)로 받는다 */
  async remoteCopyForCompare(projectId: Id): Promise<Result<{ newProjectId: Id }>> {
    const c = await this.store.conflict(projectId);
    if (!c?.remoteHead || c.remoteDeleted) return { ok: false, errors: [{ code: 'NO_CONFLICT', path: '$', message: 'no remote head to copy' }] };
    const { rev, snapshot } = await this.fetchRevision(projectId, c.remoteHead);
    void rev;
    const d = deserializeProject(snapshot);
    if (!d.ok) return d as Result<never>;
    return this.saveAsNewProject(d.value, `${d.value.title} (원격 사본)`, { originProjectId: projectId, remoteCopyOf: c.remoteHead });
  }

  /** 수동 병합 완료: 사용자가 로컬 프로젝트에서 병합·저장한 현재 head 를, 확인한 원격 head 위에 올린다(CAS 는 그대로 적용) */
  async resolveManually(projectId: Id): Promise<Result<void>> {
    const c = await this.store.conflict(projectId);
    const rec = await this.store.getRecord(projectId);
    if (!c || !rec?.sync || c.remoteDeleted) return { ok: false, errors: [{ code: 'NO_CONFLICT', path: '$', message: 'no resolvable conflict' }] };
    await this.store.addBranch(projectId, { revisionId: c.localRevision, reason: 'conflict-local', at: nowIso(new Date(this.now())), note: 'manual merge base' });
    // 충돌 항목 정리 후 현재 head 를 새 outbox 로(기대 remote head = 확인한 원격 head)
    await this.store.unlinkProject(projectId);
    const relinked = await this.store.linkProject(projectId, rec.sync.ownerId);
    if (!relinked.ok) return relinked as Result<never>;
    await this.store.updateSync(projectId, { remoteHead: c.remoteHead, sync: { lastSyncedRevision: null } });
    await this.emit(projectId); this.kick();
    return { ok: true, value: undefined };
  }

  /** 원격 삭제 vs 로컬 편집: 사용자가 로컬 버전으로 원격을 복원(tombstone 위 CAS) */
  async restoreRemoteWithLocal(projectId: Id): Promise<Result<void>> {
    const s = this.needSession();
    const c = await this.store.conflict(projectId);
    const rec = await this.store.getRecord(projectId);
    if (!rec?.sync) return { ok: false, errors: [{ code: 'NOT_LINKED', path: '$', message: 'not linked' }] };
    let target = c?.retainedRevision ?? null;
    let expected = c?.remoteHead ?? null;
    if (!c) { // 충돌 없이 원격 삭제만 표시된 경우: tombstone 직전 revision 으로 복원
      const h = this.unwrap(await this.api.head(projectId));
      if (!h.tombstoned || !h.revision) return { ok: false, errors: [{ code: 'NOT_DELETED', path: '$', message: 'remote is not deleted' }] };
      expected = h.head; target = h.revision.parentIds[0] ?? null;
    }
    if (!expected || !target) return { ok: false, errors: [{ code: 'NO_TARGET', path: '$', message: 'nothing to restore' }] };
    const r = this.unwrap(await this.api.restore(projectId, { expectedRemoteHead: expected, revisionId: target, idempotencyKey: uuid() }));
    if (r.status !== 'committed' || !r.remoteHead) return { ok: false, errors: [{ code: 'REMOTE_CONFLICT', path: '$', message: 'remote changed again; retry' }] };
    await this.store.unlinkProject(projectId);
    await this.store.linkProject(projectId, s.ownerId);
    const restoredLocal = c ? c.localRevision : rec.head;
    // 복원된 원격 내용 = target revision. 로컬 head 가 그 이후 더 편집됐으면 outbox 에 남아 이어서 올라간다.
    const out = await this.store.outbox(projectId);
    if (rec.head === restoredLocal) for (const e of out) await this.store.applySyncAck(projectId, e.id, r.remoteHead, rec.head!);
    else await this.store.updateSync(projectId, { remoteHead: r.remoteHead });
    await this.emit(projectId); this.kick();
    return { ok: true, value: undefined };
  }

  /** 클라우드 사본 삭제(tombstone). 로컬 프로젝트는 보존하고 연결만 해제한다. */
  async deleteRemote(projectId: Id): Promise<Result<void>> {
    this.needSession();
    const rec = await this.store.getRecord(projectId);
    if (!rec?.sync || !rec.remoteHead) return { ok: false, errors: [{ code: 'NOT_LINKED', path: '$', message: 'nothing to delete remotely' }] };
    const r = await this.api.deleteProject(projectId, { expectedRemoteHead: rec.remoteHead, idempotencyKey: uuid() });
    if (!r.ok) return { ok: false, errors: [{ code: r.status === 409 ? 'REMOTE_CONFLICT' : r.code, path: '$', message: r.status === 409 ? 'remote changed since last sync; pull first' : r.message }] };
    await this.store.unlinkProject(projectId);
    await this.emit(projectId);
    return { ok: true, value: undefined };
  }

  /** 비교 표시용: 원격 revision 의 snapshot 만 받아 검증·파싱한다(로컬에 저장하지 않음) */
  async peekRemote(projectId: Id, revisionId: Id): Promise<Result<import('@bass-daw/schemas').Project>> {
    const m = this.unwrap(await this.api.revision(projectId, revisionId));
    const bytes = await this.download(projectId, revisionId, m.urls.snapshot, 'snapshot', m.revision.snapshotHash);
    if (await sha256hex(bytes) !== m.revision.snapshotHash) return { ok: false, errors: [{ code: 'HASH_MISMATCH', path: '$', message: 'remote snapshot hash mismatch' }] };
    return deserializeProject(bytes);
  }

  /** 보존된 분기 revision 을 새 로컬 프로젝트로 연다 */
  branchToNewProject(projectId: Id, revisionId: Id, title: string): Promise<Result<{ newProjectId: Id }>> {
    return this.copyRevisionAsNewProject(revisionId, title, { originProjectId: projectId, branchOf: revisionId });
  }

  private async copyRevisionAsNewProject(revisionId: Id, title: string, meta: Record<string, string>): Promise<Result<{ newProjectId: Id }>> {
    const rev = await this.store.revision(revisionId);
    const bytes = rev ? await this.store.snapshotBytes(rev.snapshotHash) : null;
    if (!bytes) return { ok: false, errors: [{ code: 'SNAPSHOT_CORRUPT', path: '$', message: 'local snapshot missing' }] };
    const d = deserializeProject(bytes);
    if (!d.ok) return d as Result<never>;
    return this.saveAsNewProject(d.value, title, meta);
  }

  private async saveAsNewProject(p: import('@bass-daw/schemas').Project, title: string, meta: Record<string, string>): Promise<Result<{ newProjectId: Id }>> {
    const id = uuid();
    const copy = { ...p, id, title, updatedAt: nowIso(new Date(Math.max(this.now(), Date.parse(p.updatedAt)))), metadata: { ...p.metadata, ...meta } };
    if (!serializeProject(copy).ok) return { ok: false, errors: [{ code: 'INVALID', path: '$', message: 'copy failed validation' }] };
    const l = await this.store.acquireLease(id); if (!l.ok) return l as Result<never>;
    try {
      const r = await this.store.commit(copy, null, 0);
      return r.ok ? { ok: true, value: { newProjectId: id } } : r as Result<never>;
    } finally { await this.store.releaseLease(id); }
  }
}

async function sha256hex(b: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return Array.from(new Uint8Array(await subtle.digest('SHA-256', b as unknown as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');
  return new Sha256().update(b).digestHex();
}
