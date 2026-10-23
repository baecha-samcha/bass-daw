// 오디오 import 파이프라인: 원본 바이트 SHA 검증 저장 → 디코딩(worker 또는 브라우저 디코더) → 파형 캐시
import type { Asset } from '@bass-daw/schemas';
import { uuid } from '@bass-daw/schemas';
import { deserializePyramid, type WaveformPyramid } from '@bass-daw/audio-engine';
import { paths, type LocalStore } from '@bass-daw/storage';
import { decodeBytes } from './pcm-cache.ts';

let worker: Worker | null = null; let seq = 0;
const waiters = new Map<number, (m: { ok: boolean; [k: string]: unknown }) => void>();
function call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<{ ok: boolean; [k: string]: unknown }> {
  worker ??= new Worker(new URL('../workers/media.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { const w = waiters.get(e.data.id); if (w) { waiters.delete(e.data.id); w(e.data); } };
  const id = ++seq;
  return new Promise((res) => { waiters.set(id, res); worker!.postMessage({ ...msg, id }, transfer); });
}

export interface ImportedAudio { asset: Asset; pyramid: WaveformPyramid }

export async function importAudioFile(store: LocalStore, file: Blob, name: string, license: Asset['license'] = { name: 'user import', origin: name, redistribution: 'unknown' }): Promise<ImportedAudio> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let meta: { sampleRate: number; channels: number; frames: number; pyramid: Uint8Array };
  const r = await call({ type: 'decode-wav', bytes: bytes.slice().buffer });
  if (r.ok) meta = r as never;
  else {
    const pcm = await decodeBytes(bytes, file.type || 'audio/*');
    const chans = pcm.channels.map((c) => c.slice().buffer);
    const p = await call({ type: 'pyramid', channels: chans, sampleRate: pcm.sampleRate }, chans);
    if (!p.ok) throw new Error(String(p.error));
    meta = { sampleRate: pcm.sampleRate, channels: pcm.channels.length, frames: pcm.frames, pyramid: p.pyramid as Uint8Array };
  }
  if (meta.channels < 1 || meta.channels > 2) throw new Error('v1 supports mono/stereo audio only');
  if (meta.sampleRate < 8000 || meta.sampleRate > 192000) throw new Error('sample rate outside 8k..192k');
  // 원본 바이트를 그대로 저장(비파괴). SHA-256 은 원본 파일 바이트 기준.
  const imp = await store.importAsset(bytes);
  if (!imp.ok) throw new Error(`${imp.errors[0].code}: ${imp.errors[0].message}`);
  await store.bytes.write(paths.waveform(imp.value.hash), new Uint8Array(meta.pyramid)).catch(() => undefined);
  return {
    asset: { id: uuid(), sha256: imp.value.hash, byteLength: bytes.length, mediaType: file.type || guessType(name), audio: { sampleRate: meta.sampleRate, channels: meta.channels, frameCount: meta.frames }, license },
    pyramid: deserializePyramid(new Uint8Array(meta.pyramid)),
  };
}

const pyrCache = new Map<string, Promise<WaveformPyramid | null>>();
/** 파형 캐시 읽기, 없거나 손상이면 원본에서 재생성(파형 실패가 음악 데이터 손실을 일으키지 않음) */
export function loadPyramid(store: LocalStore, hash: string, mediaType: string): Promise<WaveformPyramid | null> {
  let p = pyrCache.get(hash);
  if (!p) {
    p = (async () => {
      try {
        const c = await store.bytes.read(paths.waveform(hash));
        if (c) return deserializePyramid(new Uint8Array(await c.arrayBuffer()));
      } catch { /* 재생성 */ }
      const blob = await store.readAsset(hash);
      if (!blob) return null;
      try {
        const pcm = await decodeBytes(new Uint8Array(await blob.arrayBuffer()), mediaType);
        const chans = pcm.channels.map((x) => x.slice().buffer);
        const r = await call({ type: 'pyramid', channels: chans, sampleRate: pcm.sampleRate }, chans);
        if (!r.ok) return null;
        await store.bytes.write(paths.waveform(hash), new Uint8Array(r.pyramid as Uint8Array)).catch(() => undefined);
        return deserializePyramid(new Uint8Array(r.pyramid as Uint8Array));
      } catch { return null; }
    })();
    pyrCache.set(hash, p);
  }
  return p;
}

function guessType(name: string) { const ext = name.split('.').pop()?.toLowerCase(); return ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : ext === 'flac' ? 'audio/flac' : ext === 'm4a' ? 'audio/mp4' : 'application/octet-stream'; }
