// 최소 ZIP 리더/라이터. 압축 해제 전에 central directory 로 한도·경로·symlink 를 검사한다(04 §4 악성 ZIP 방어).
import { Inflate, deflateSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export const ZIP_LIMITS = { compressed: 1024 ** 3, uncompressed: 2 * 1024 ** 3, entries: 10_000, ratio: 100 };

export interface ZipEntryInput { name: string; data: Blob | Uint8Array; compress?: boolean }

async function blobCrc(b: Blob): Promise<number> {
  let c = 0;
  for (let i = 0; i < b.size; i += 1 << 20) c = crc32(new Uint8Array(await b.slice(i, i + (1 << 20)).arrayBuffer()), c);
  return c;
}

export async function writeZip(entries: ZipEntryInput[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    let payload: Blob | Uint8Array; let method: number; let crc: number; let usize: number;
    if (e.compress && e.data instanceof Uint8Array) {
      crc = crc32(e.data); usize = e.data.length; payload = deflateSync(e.data, { level: 6 }); method = 8;
    } else {
      payload = e.data; method = 0; usize = e.data instanceof Uint8Array ? e.data.length : e.data.size;
      crc = e.data instanceof Uint8Array ? crc32(e.data) : await blobCrc(e.data);
    }
    const csize = payload instanceof Uint8Array ? payload.length : payload.size;
    if (csize >= 0xffffffff || usize >= 0xffffffff || offset >= 0xffffffff) throw new Error('EXPORT_LIMIT: ZIP64 not supported');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, csize, true); lh.setUint32(22, usize, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name as unknown as BlobPart, payload as unknown as BlobPart);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x031e, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, csize, true); ch.setUint32(24, usize, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, (0o100644 << 16) >>> 0, true); ch.setUint32(42, offset, true);
    const c = new Uint8Array(46 + name.length); c.set(new Uint8Array(ch.buffer)); c.set(name, 46);
    central.push(c);
    offset += 30 + name.length + csize;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as unknown as BlobPart[]), eocd.buffer], { type: 'application/zip' });
}

export interface ZipEntry { name: string; method: number; crc: number; csize: number; usize: number; offset: number; flags: number }
export type ZipResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function safeEntryName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name) || name.includes('\0')) return false;
  return !name.split('/').some((p) => p === '..' || p === '.' || p === '');
}

export async function readZipDirectory(file: Blob, limits = ZIP_LIMITS): Promise<ZipResult<ZipEntry[]>> {
  if (file.size > limits.compressed) return { ok: false, code: 'ARCHIVE_LIMIT', message: 'archive larger than 1GiB' };
  if (file.size < 22) return { ok: false, code: 'ARCHIVE_INVALID', message: 'not a zip' };
  const tailLen = Math.min(file.size, 65_557);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  let eo = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eo = i; break; }
  if (eo < 0) return { ok: false, code: 'ARCHIVE_INVALID', message: 'EOCD not found' };
  const dv = new DataView(tail.buffer, tail.byteOffset + eo);
  const count = dv.getUint16(10, true), cdSize = dv.getUint32(12, true), cdOff = dv.getUint32(16, true);
  if (count === 0xffff || cdOff === 0xffffffff) return { ok: false, code: 'ARCHIVE_INVALID', message: 'ZIP64 not supported' };
  if (count > limits.entries) return { ok: false, code: 'ARCHIVE_LIMIT', message: `more than ${limits.entries} entries` };
  if (cdOff + cdSize > file.size) return { ok: false, code: 'ARCHIVE_INVALID', message: 'central directory out of range' };
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const v = new DataView(cd.buffer);
  const out: ZipEntry[] = []; const names = new Set<string>();
  let p = 0, totalU = 0, totalC = 0;
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== 0x02014b50) return { ok: false, code: 'ARCHIVE_INVALID', message: 'bad central header' };
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const ext = v.getUint32(p + 38, true), off = v.getUint32(p + 42, true);
    let name: string;
    try { name = dec.decode(cd.subarray(p + 46, p + 46 + nl)); } catch { return { ok: false, code: 'ARCHIVE_PATH', message: 'invalid entry name encoding' }; }
    p += 46 + nl + xl + cl;
    if (!safeEntryName(name)) return { ok: false, code: 'ARCHIVE_PATH', message: `unsafe entry path: ${name}` };
    if (((ext >>> 16) & 0xf000) === 0xa000) return { ok: false, code: 'ARCHIVE_PATH', message: `symlink entry: ${name}` };
    if (flags & 1) return { ok: false, code: 'ARCHIVE_INVALID', message: 'encrypted entry' };
    if (method !== 0 && method !== 8) return { ok: false, code: 'ARCHIVE_INVALID', message: `unsupported method ${method}` };
    if (names.has(name)) return { ok: false, code: 'ARCHIVE_INVALID', message: `duplicate entry ${name}` };
    names.add(name);
    if (method === 0 && csize !== usize) return { ok: false, code: 'ARCHIVE_INVALID', message: 'stored size mismatch' };
    if (csize > 0 && usize / csize > limits.ratio) return { ok: false, code: 'ARCHIVE_LIMIT', message: `compression ratio > ${limits.ratio}` };
    if (csize === 0 && usize > 0) return { ok: false, code: 'ARCHIVE_LIMIT', message: 'compression ratio infinite' };
    totalU += usize; totalC += csize;
    if (totalU > limits.uncompressed) return { ok: false, code: 'ARCHIVE_LIMIT', message: 'uncompressed > 2GiB' };
    out.push({ name, method, crc, csize, usize, offset: off, flags });
  }
  if (totalC > 0 && totalU / totalC > limits.ratio) return { ok: false, code: 'ARCHIVE_LIMIT', message: 'total compression ratio too high' };
  return { ok: true, value: out };
}

/** 선언된 usize 를 넘으면 중단(헤더 위조 zip bomb 방어). CRC 검증. */
export async function readZipEntry(file: Blob, e: ZipEntry): Promise<ZipResult<Uint8Array>> {
  const lh = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
  if (lh.byteLength < 30 || lh.getUint32(0, true) !== 0x04034b50) return { ok: false, code: 'ARCHIVE_INVALID', message: 'bad local header' };
  const start = e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  if (start + e.csize > file.size) return { ok: false, code: 'ARCHIVE_INVALID', message: 'entry out of range' };
  const out = new Uint8Array(e.usize);
  let n = 0; let overflow = false;
  if (e.method === 0) {
    out.set(new Uint8Array(await file.slice(start, start + e.csize).arrayBuffer())); n = e.csize;
  } else {
    const inf = new Inflate((chunk) => {
      if (overflow) return;
      if (n + chunk.length > e.usize) { overflow = true; return; }
      out.set(chunk, n); n += chunk.length;
    });
    try {
      for (let i = 0; i < e.csize && !overflow; i += 1 << 20) {
        const end = Math.min(e.csize, i + (1 << 20));
        inf.push(new Uint8Array(await file.slice(start + i, start + end).arrayBuffer()), end === e.csize);
      }
    } catch (err) { return { ok: false, code: 'ARCHIVE_INVALID', message: `inflate failed: ${(err as Error).message}` }; }
  }
  if (overflow || n !== e.usize) return { ok: false, code: 'ARCHIVE_LIMIT', message: `entry ${e.name} size differs from header` };
  if (crc32(out) !== e.crc) return { ok: false, code: 'ARCHIVE_INVALID', message: `crc mismatch ${e.name}` };
  return { ok: true, value: out };
}
