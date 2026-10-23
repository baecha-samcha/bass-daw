// 큰 바이너리 저장 어댑터(04 §2). OPFS 우선, 불가 시 IndexedDB Blob. 둘 다 같은 commit 프로토콜을 따른다.
import { Sha256 } from '@bass-daw/schemas';
import { openDb, req, txDone } from './idb.ts';

export interface WriteResult { bytes: number; hash: string }
export interface ByteStore {
  readonly kind: 'opfs' | 'idb' | 'memory';
  /** 스트리밍 쓰기 + 증분 hash. 닫힌 뒤 결과 반환. */
  write(path: string, data: Blob | Uint8Array | AsyncIterable<Uint8Array>): Promise<WriteResult>;
  read(path: string): Promise<Blob | null>;
  size(path: string): Promise<number | null>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const paths = {
  asset: (hash: string) => `assets/${hash}`,
  staging: (id: string) => `staging/${id}`,
  waveform: (hash: string) => `cache/waveforms/${hash}`,
  pcm: (hash: string, rate: number, version = 1) => `cache/pcm/${hash}-${rate}-v${version}`,
  export: (id: string) => `exports/${id}`,
  segment: (journalId: string, n: number) => `staging/rec-${journalId}-${String(n).padStart(5, '0')}`,
};

export async function* chunksOf(data: Blob | Uint8Array | AsyncIterable<Uint8Array>, chunk = 1 << 20): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) { for (let i = 0; i < data.length; i += chunk) yield data.subarray(i, Math.min(data.length, i + chunk)); return; }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    for (let i = 0; i < data.size; i += chunk) yield new Uint8Array(await data.slice(i, Math.min(data.size, i + chunk)).arrayBuffer());
    return;
  }
  yield* data as AsyncIterable<Uint8Array>;
}

export async function hashBlob(b: Blob): Promise<WriteResult> {
  const h = new Sha256(); let n = 0;
  for await (const c of chunksOf(b)) { h.update(c); n += c.length; }
  return { bytes: n, hash: h.digestHex() };
}

export class MemoryByteStore implements ByteStore {
  readonly kind = 'memory' as const;
  files = new Map<string, Uint8Array>();
  /** 테스트용 장애 주입: true 를 반환하면 QuotaExceededError */
  quotaFail: (path: string, bytes: number) => boolean = () => false;
  async write(path: string, data: Blob | Uint8Array | AsyncIterable<Uint8Array>): Promise<WriteResult> {
    const h = new Sha256(); const parts: Uint8Array[] = []; let n = 0;
    for await (const c of chunksOf(data)) { h.update(c); parts.push(c.slice()); n += c.length; }
    if (this.quotaFail(path, n)) throw new DOMException('quota', 'QuotaExceededError');
    const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    this.files.set(path, all);
    return { bytes: n, hash: h.digestHex() };
  }
  async read(path: string) { const f = this.files.get(path); return f ? new Blob([f as unknown as BlobPart]) : null; }
  async size(path: string) { return this.files.get(path)?.length ?? null; }
  async remove(path: string) { this.files.delete(path); }
  async list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
}

/** IndexedDB 'blobs' store 에 Blob 으로 저장. 1MiB chunk 단위 키로 나눠 큰 파일도 스트리밍한다. */
export class IdbByteStore implements ByteStore {
  readonly kind = 'idb' as const;
  constructor(private dbp: Promise<IDBDatabase>) {}
  static open(name = 'bass-daw', factory?: IDBFactory) { return new IdbByteStore(openDb(name, factory)); }
  async write(path: string, data: Blob | Uint8Array | AsyncIterable<Uint8Array>): Promise<WriteResult> {
    const db = await this.dbp;
    await this.remove(path);
    const h = new Sha256(); let n = 0; let i = 0;
    for await (const c of chunksOf(data)) {
      h.update(c); n += c.length;
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put({ path: `${path}#${String(i++).padStart(8, '0')}`, data: new Blob([c.slice() as unknown as BlobPart]) });
      await txDone(tx);
    }
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({ path, chunks: i, bytes: n });
    await txDone(tx);
    return { bytes: n, hash: h.digestHex() };
  }
  async read(path: string): Promise<Blob | null> {
    const db = await this.dbp;
    const tx = db.transaction('blobs', 'readonly');
    const head = await req(tx.objectStore('blobs').get(path)) as { chunks: number } | undefined;
    if (!head) return null;
    const parts: Blob[] = [];
    for (let i = 0; i < head.chunks; i++) {
      const r = await req(tx.objectStore('blobs').get(`${path}#${String(i).padStart(8, '0')}`)) as { data: Blob } | undefined;
      if (!r) return null;
      parts.push(r.data);
    }
    return new Blob(parts);
  }
  async size(path: string) {
    const db = await this.dbp;
    const r = await req(db.transaction('blobs', 'readonly').objectStore('blobs').get(path)) as { bytes: number } | undefined;
    return r ? r.bytes : null;
  }
  async remove(path: string) {
    const db = await this.dbp;
    const tx = db.transaction('blobs', 'readwrite');
    const os = tx.objectStore('blobs');
    os.delete(path);
    os.delete(IDBKeyRange.bound(`${path}#`, `${path}#￿`));
    await txDone(tx);
  }
  async list(prefix: string) {
    const db = await this.dbp;
    const keys = await req(db.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))) as string[];
    return keys.filter((k) => !k.includes('#'));
  }
}

/** Origin Private File System. 경로는 host 가 생성한 상대 경로만 사용한다. */
export class OpfsByteStore implements ByteStore {
  readonly kind = 'opfs' as const;
  private constructor(private root: FileSystemDirectoryHandle) {}
  static async open(): Promise<OpfsByteStore | null> {
    try {
      const root = await navigator.storage.getDirectory();
      return new OpfsByteStore(root);
    } catch { return null; }
  }
  private async dirFor(path: string, create: boolean): Promise<[FileSystemDirectoryHandle, string] | null> {
    const parts = path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error('INVALID_PATH');
    let d = this.root;
    try {
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
    } catch { return null; }
    return [d, parts.at(-1)!];
  }
  async write(path: string, data: Blob | Uint8Array | AsyncIterable<Uint8Array>): Promise<WriteResult> {
    const [d, name] = (await this.dirFor(path, true))!;
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    const h = new Sha256(); let n = 0;
    try {
      for await (const c of chunksOf(data)) { h.update(c); n += c.length; await w.write(c as unknown as FileSystemWriteChunkType); }
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch { /* ignore */ }
      throw e;
    }
    return { bytes: n, hash: h.digestHex() };
  }
  async read(path: string): Promise<Blob | null> {
    const r = await this.dirFor(path, false);
    if (!r) return null;
    try { return await (await r[0].getFileHandle(r[1])).getFile(); } catch { return null; }
  }
  async size(path: string) { return (await this.read(path))?.size ?? null; }
  async remove(path: string) {
    const r = await this.dirFor(path, false);
    if (!r) return;
    try { await r[0].removeEntry(r[1]); } catch { /* not found */ }
  }
  async list(prefix: string): Promise<string[]> {
    const dir = prefix.replace(/\/[^/]*$/, '');
    const r = await this.dirFor(`${prefix.endsWith('/') ? prefix : dir + '/'}x`, false);
    if (!r) return [];
    const out: string[] = [];
    for await (const [name] of (r[0] as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const full = `${prefix.endsWith('/') ? prefix : dir + '/'}${name}`;
      if (full.startsWith(prefix)) out.push(full);
    }
    return out;
  }
}
