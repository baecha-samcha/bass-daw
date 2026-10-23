// Offline WAV export worker (01 §8): block renderer 를 스트리밍으로 OPFS exports/<uuid>.wav 에 쓴다.
import { renderToWav, type ExportOptions, type Pcm } from '@bass-daw/audio-engine';
import type { Project } from '@bass-daw/schemas';

let cancelled = false;
self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'render') return;
  cancelled = false;
  const project = m.project as Project; const opts = m.options as ExportOptions;
  const pcm = new Map<string, Pcm>((m.pcm as [string, Float32Array[], number][]).map(([h, ch, sr]) => [h, { sampleRate: sr, channels: ch, frames: ch[0].length }]));
  let writable: FileSystemWritableFileStream | null = null; let path: string | null = null;
  const parts: Uint8Array[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('exports', { create: true });
    const name = `${crypto.randomUUID()}.wav`;
    writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    path = `exports/${name}`;
  } catch { writable = null; }
  const t0 = performance.now();
  const plugins = new Map<string, { key: string; manifest: never; memoryPages: number }>((m.plugins ?? []) as [string, { key: string; manifest: never; memoryPages: number }][]);
  const r = await renderToWav({ project, pcm, profile: m.profile, plugins: (id, v) => plugins.get(`${id}@${v}`) ?? null, wasm: new Map(((m.wasm ?? []) as [string, Uint8Array][]).map(([k, b]) => [k, new WebAssembly.Module(b as unknown as BufferSource)])), pluginHashes: m.pluginHashes ?? [], isCancelled: () => cancelled, onProgress: (d, t) => (self as unknown as Worker).postMessage({ type: 'progress', done: d, total: t }) }, opts, async (chunk) => {
    if (writable) await writable.write(chunk as unknown as FileSystemWriteChunkType); else parts.push(chunk.slice());
  });
  if (writable) { if (r.ok) await writable.close(); else await writable.abort().catch(() => undefined); }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
  if (!r.ok) { (self as unknown as Worker).postMessage({ type: 'done', ok: false, code: r.code, message: r.message, diagnostics: r.diagnostics }); return; }
  (self as unknown as Worker).postMessage({ type: 'done', ok: true, receipt: r.receipt, path, blob: writable ? null : new Blob(parts as unknown as BlobPart[], { type: 'audio/wav' }), ms: performance.now() - t0, heap: mem });
};
