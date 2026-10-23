// 업로드 해시 전용 Worker. Blob 은 참조로 전달되고(structured clone 은 바이트를 복사하지 않음)
// chunk 하나씩 slice→arrayBuffer 로 읽어 메모리를 chunk 크기로 제한한다(bounded streaming).
import { Sha256 } from '@bass-daw/schemas';

type In = { type: 'hash'; id: number; blob: Blob; chunkBytes: number } | { type: 'cancel'; id: number } | { type: 'crash' };
const cancelled = new Set<number>();
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  if (m.type === 'crash') { setTimeout(() => { throw new Error('diagnostic hash worker crash'); }); return; } // 재시작 경로 시험용(uncaught → worker error 이벤트)
  const { id, blob, chunkBytes } = m;
  try {
    if (!(blob instanceof Blob)) throw new TypeError('blob required');
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) throw new RangeError(`bad chunkBytes ${chunkBytes}`);
    const full = new Sha256(); const chunkHashes: string[] = [];
    let maxHeld = 0;
    for (let o = 0; o < blob.size || (blob.size === 0 && chunkHashes.length === 0); o += chunkBytes) {
      if (cancelled.has(id)) { cancelled.delete(id); post({ type: 'error', id, code: 'CANCELLED', message: 'hashing cancelled' }); return; }
      const buf = await blob.slice(o, Math.min(blob.size, o + chunkBytes)).arrayBuffer();
      maxHeld = Math.max(maxHeld, buf.byteLength);
      full.update(new Uint8Array(buf));
      chunkHashes.push(hex(await crypto.subtle.digest('SHA-256', buf)));
      post({ type: 'progress', id, done: Math.min(blob.size, o + chunkBytes), total: blob.size });
      if (blob.size === 0) break;
    }
    post({ type: 'done', id, hash: full.digestHex(), chunkHashes, maxHeld });
  } catch (err) {
    post({ type: 'error', id, code: (err as DOMException)?.name === 'NotReadableError' ? 'READ_ERROR' : 'HASH_ERROR', message: String((err as Error)?.message ?? err) });
  } finally { cancelled.delete(id); }
};
