// 04 §3 autosave: 마지막 편집 후 1초 debounce, 연속 편집 중 최대 5초 간격, 명시적 Save 즉시.
// pending commit 중 새 편집은 최신 sequence 를 별도 유지하고 다음 commit 을 예약한다.
import type { Project, Result } from '@bass-daw/schemas';
import type { Revision, SaveStatus } from './local-store.ts';

export interface AutosaveDeps {
  commit(project: Project, expectedHead: string | null, editSequence: number): Promise<Result<Revision>>;
  clearCaches(): Promise<unknown>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

export class AutosaveController {
  status: SaveStatus = 'clean';
  lastError: string | null = null;
  head: string | null;
  savedSequence: number;
  private latest: { project: Project; seq: number } | null = null;
  private timer: unknown = null;
  private firstDirtyAt: number | null = null;
  private inflight: Promise<void> | null = null;
  private listeners = new Set<(s: AutosaveController) => void>();
  debounceMs = 1000;
  maxIntervalMs = 5000;

  constructor(private deps: AutosaveDeps, head: string | null, savedSequence: number) {
    this.head = head; this.savedSequence = savedSequence;
  }

  subscribe(fn: (s: AutosaveController) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private set(s: SaveStatus, err: string | null = null) { this.status = s; this.lastError = err; for (const l of this.listeners) l(this); }

  /** 편집마다 호출 */
  notify(project: Project, seq: number): void {
    if (this.status === 'read-only') return;
    if (seq <= this.savedSequence && !this.latest) return;
    this.latest = { project, seq };
    const t = this.deps.now();
    this.firstDirtyAt ??= t;
    if (this.status !== 'saving') this.set('dirty');
    if (this.timer) this.deps.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstDirtyAt + this.maxIntervalMs - t));
    this.timer = this.deps.setTimeout(() => { this.timer = null; void this.flush(); }, wait);
  }

  /** 명시적 Save 또는 타이머 */
  async flush(): Promise<void> {
    if (this.inflight) { await this.inflight; if (this.latest) return this.flush(); return; }
    const job = this.latest;
    if (!job) return;
    this.latest = null; this.firstDirtyAt = null;
    if (this.timer) { this.deps.clearTimeout(this.timer); this.timer = null; }
    this.set('saving');
    this.inflight = (async () => {
      let r = await this.deps.commit(job.project, this.head, job.seq);
      if (!r.ok && r.errors[0].code === 'QUOTA') {
        await this.deps.clearCaches();
        r = await this.deps.commit(job.project, this.head, job.seq);
      }
      if (r.ok) {
        this.head = r.value.id; this.savedSequence = job.seq;
        this.set(this.latest ? 'dirty' : 'saved');
      } else {
        const code = r.errors[0].code;
        // 실패해도 메모리 편집은 유지하고 다음 편집에서 재시도한다
        if (!this.latest) this.latest = job;
        if (code === 'WRITER_LOST' || code === 'LOCAL_HEAD_CHANGED') this.set('read-only', `${code}: ${r.errors[0].message}`);
        else if (code === 'QUOTA') this.set('quota-error', 'Storage quota exceeded. Save a project file (.dawbae) to keep your work.');
        else this.set('degraded', `${code}: ${r.errors[0].message}`);
      }
    })();
    try { await this.inflight; } finally { this.inflight = null; }
    const pending = this.latest as { project: Project; seq: number } | null;
    if (pending && this.status === 'dirty') this.notify(pending.project, pending.seq);
  }

  markReadOnly(reason: string) { this.set('read-only', reason); }
  dispose() { if (this.timer) this.deps.clearTimeout(this.timer); this.listeners.clear(); }
}
