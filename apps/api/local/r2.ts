// 로컬 R2 어댑터(메모리 또는 디렉터리 영속). Worker 가 쓰는 R2Bucket 부분 집합: head/get(range)/put/delete/list/multipart.
// multipart complete 는 part 를 순서대로 이어 붙여 최종 객체를 만든다(실제 R2 와 같이 complete 전에는 최종 key 가 없다).
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { R2Bucket, R2Object, R2ObjectBody, R2MultipartUpload, R2UploadedPart } from '../src/env.ts';

async function toBytes(v: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  return new Uint8Array(await new Response(v).arrayBuffer());
}

export class LocalR2 implements R2Bucket {
  private mem = new Map<string, { bytes: Uint8Array; etag: string; uploaded: Date }>();
  private mpu = new Map<string, { key: string; parts: Map<number, { bytes: Uint8Array; etag: string }> }>();
  /** 장애 주입: 다음 uploadPart 를 실패시킨다(네트워크/R2 장애) */
  failNextPart: Error | null = null;
  /** 테스트 시계(Worker 의 __now 와 맞춤) */
  now: () => number = () => Date.now();
  constructor(private dir: string | null = null) {
    if (dir) {
      mkdirSync(`${dir}/objects`, { recursive: true });
      for (const f of readdirSync(`${dir}/objects`)) {
        const bytes = new Uint8Array(readFileSync(`${dir}/objects/${f}`));
        this.mem.set(decodeURIComponent(f), { bytes, etag: createHash('md5').update(bytes).digest('hex'), uploaded: new Date() });
      }
    }
  }
  private obj(key: string, e: { bytes: Uint8Array; etag: string; uploaded: Date }): R2Object { return { key, size: e.bytes.length, etag: e.etag, uploaded: e.uploaded }; }
  private store(key: string, bytes: Uint8Array, etag = createHash('md5').update(bytes).digest('hex')): R2Object {
    const e = { bytes, etag, uploaded: new Date(this.now()) };
    this.mem.set(key, e);
    if (this.dir) writeFileSync(`${this.dir}/objects/${encodeURIComponent(key)}`, bytes);
    return this.obj(key, e);
  }
  async head(key: string) { const e = this.mem.get(key); return e ? this.obj(key, e) : null; }
  async get(key: string, opts?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } }): Promise<R2ObjectBody | R2Object | null> {
    const e = this.mem.get(key); if (!e) return null;
    if (opts?.onlyIf?.etagMatches !== undefined && opts.onlyIf.etagMatches !== e.etag) return this.obj(key, e); // precondition 실패: body 없음
    const b = opts?.range ? e.bytes.subarray(opts.range.offset, opts.range.offset + opts.range.length) : e.bytes;
    const copy = new Uint8Array(b);
    return { ...this.obj(key, e), body: new Blob([copy]).stream(), arrayBuffer: async () => copy.buffer };
  }
  async put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>) { return this.store(key, await toBytes(value)); }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) { this.mem.delete(k); if (this.dir && existsSync(`${this.dir}/objects/${encodeURIComponent(k)}`)) rmSync(`${this.dir}/objects/${encodeURIComponent(k)}`); }
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const all = [...this.mem.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort().filter((k) => !opts.cursor || k > opts.cursor);
    const lim = opts.limit ?? 1000; const page = all.slice(0, lim);
    return { objects: page.map((k) => this.obj(k, this.mem.get(k)!)), truncated: all.length > lim, cursor: all.length > lim ? page[page.length - 1] : undefined };
  }
  async createMultipartUpload(key: string): Promise<R2MultipartUpload> {
    const id = randomUUID();
    this.mpu.set(id, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, id);
  }
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const self = this;
    return {
      key, uploadId,
      async uploadPart(n, value): Promise<R2UploadedPart> {
        const u = self.mpu.get(uploadId); if (!u || u.key !== key) throw new Error('R2: NoSuchUpload');
        if (self.failNextPart) { const e = self.failNextPart; self.failNextPart = null; throw e; }
        const bytes = await toBytes(value);
        const etag = createHash('md5').update(bytes).digest('hex');
        u.parts.set(n, { bytes, etag });
        return { partNumber: n, etag };
      },
      async complete(parts) {
        const u = self.mpu.get(uploadId); if (!u || u.key !== key) throw new Error('R2: NoSuchUpload');
        const chunks = parts.map((p) => { const x = u.parts.get(p.partNumber); if (!x || x.etag !== p.etag) throw new Error(`R2: InvalidPart ${p.partNumber}`); return x.bytes; });
        const out = new Uint8Array(chunks.reduce((a, b) => a + b.length, 0)); let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        self.mpu.delete(uploadId);
        // S3/R2 multipart etag 형식: md5(part md5 들의 연결)-N
        const etag = `${createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(u.parts.get(p.partNumber)!.etag, 'hex')))).digest('hex')}-${parts.length}`;
        return self.store(key, out, etag);
      },
      async abort() { self.mpu.delete(uploadId); },
    };
  }
  /** 테스트: 저장된 객체를 직접 변조(R2 손상/서버 측 hash 불일치 시나리오) */
  tamper(key: string, f: (b: Uint8Array) => Uint8Array) { const e = this.mem.get(key); if (e) this.store(key, f(new Uint8Array(e.bytes))); }
  keys() { return [...this.mem.keys()].sort(); }
  /** 테스트: 저장된 바이트 직접 읽기 */
  read(key: string) { const e = this.mem.get(key); return e ? new Uint8Array(e.bytes) : null; }
  pendingMultipart() { return this.mpu.size; }
}
