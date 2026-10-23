// 업로드 해시를 전용 Web Worker 에서 수행(메인 스레드 long task 방지). SyncEngine 의 ObjectHasher 로 주입된다.
// - 취소: AbortSignal → worker 에 cancel, promise 는 HashCancelled 로 reject
// - 오류 전달: worker 의 READ_ERROR/HASH_ERROR 를 Error(code) 로 reject
// - 재시작: worker 가 죽으면(onerror) 진행 중 작업을 새 worker 에서 한 번 다시 시도, 이후 작업도 새 worker 사용
import { HashCancelled, type ObjectHasher } from '@bass-daw/storage';

interface Job { blob: Blob; chunkBytes: number; resolve: (v: { hash: string; chunkHashes: string[]; maxHeld: number }) => void; reject: (e: Error) => void; retried: boolean; onProgress?: (d: number, t: number) => void }

export class WorkerHasher {
  private w: Worker | null = null;
  private jobs = new Map<number, Job>();
  private seq = 0;
  restarts = 0;
  lastMaxHeld = 0;

  private worker(): Worker {
    if (this.w) return this.w;
    const w = new Worker(new URL('../workers/hash.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data as { type: string; id: number; [k: string]: unknown };
      const j = this.jobs.get(m.id); if (!j) return;
      if (m.type === 'progress') { j.onProgress?.(m.done as number, m.total as number); return; }
      this.jobs.delete(m.id);
      if (m.type === 'done') { this.lastMaxHeld = m.maxHeld as number; j.resolve({ hash: m.hash as string, chunkHashes: m.chunkHashes as string[], maxHeld: m.maxHeld as number }); }
      else if (m.code === 'CANCELLED') j.reject(new HashCancelled());
      else j.reject(Object.assign(new Error(`${m.code}: ${m.message}`), { code: m.code }));
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      // worker 사망: 종료 후 진행 중 작업을 새 worker 로 1회 재시도
      w.terminate(); if (this.w === w) this.w = null; this.restarts++;
      const pending = [...this.jobs.entries()]; this.jobs.clear();
      for (const [, j] of pending) {
        if (j.retried) j.reject(Object.assign(new Error('WORKER_CRASHED: hash worker stopped twice'), { code: 'WORKER_CRASHED' }));
        else this.start({ ...j, retried: true });
      }
    };
    this.w = w;
    return w;
  }

  private start(j: Job): number {
    const id = ++this.seq;
    this.jobs.set(id, j);
    this.worker().postMessage({ type: 'hash', id, blob: j.blob, chunkBytes: j.chunkBytes });
    return id;
  }

  hash(data: Blob | Uint8Array, chunkBytes: number, signal?: AbortSignal, onProgress?: (d: number, t: number) => void) {
    const blob = data instanceof Blob ? data : new Blob([data as unknown as BlobPart]);
    return new Promise<{ hash: string; chunkHashes: string[]; maxHeld: number }>((resolve, reject) => {
      if (signal?.aborted) return reject(new HashCancelled());
      const id = this.start({ blob, chunkBytes, resolve, reject, retried: false, onProgress });
      signal?.addEventListener('abort', () => {
        // 재시작으로 id 가 바뀌었을 수 있으니 같은 promise 의 작업을 찾아 취소
        for (const [k, j] of this.jobs) if (j.resolve === resolve) { this.w?.postMessage({ type: 'cancel', id: k }); return; }
        void id;
      }, { once: true });
    });
  }

  /** 진단: worker 강제 오류(재시작 경로 시험) */
  crash() { this.w?.postMessage({ type: 'crash' }); }
  dispose() { this.w?.terminate(); this.w = null; }
}

export const workerHasher = new WorkerHasher();
export const hashInWorker: ObjectHasher = (data, chunkBytes, signal) => workerHasher.hash(data, chunkBytes, signal);
