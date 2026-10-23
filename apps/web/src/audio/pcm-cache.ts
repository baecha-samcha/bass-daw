// 디코딩 PCM 캐시(01 §6): 원본 압축 파일과 분리, 컨텍스트 rate 로 resample, 가능하면 SAB 로 worklet 과 공유.
import { decodeWav, resampleLinear, type Pcm } from '@bass-daw/audio-engine';

export type AssetLoader = (hash: string) => Promise<Blob | null>;

const cache = new Map<string, Pcm>(); // key: hash@rate
const inflight = new Map<string, Promise<Pcm | null>>();

function shareable(p: Pcm): Pcm {
  if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) return p;
  return { ...p, channels: p.channels.map((c) => { const s = new Float32Array(new SharedArrayBuffer(c.length * 4)); s.set(c); return s; }) };
}

export async function decodeBytes(bytes: Uint8Array, mediaType: string): Promise<Pcm> {
  if (mediaType.includes('wav') || (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) {
    try { return decodeWav(bytes); } catch { /* 브라우저 디코더로 재시도 */ }
  }
  // decodeAudioData 는 컨텍스트 rate 로 resample 하므로 원본 rate 보존을 위해 큰 rate 의 OfflineAudioContext 사용 불가 —
  // 원본 rate 는 알 수 없으므로 48k 로 디코딩하고 메타데이터에 이 rate 를 기록한다(decisions/0007).
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(bytes.slice().buffer);
  const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice());
  return { sampleRate: buf.sampleRate, channels, frames: buf.length };
}

export async function getPcm(hash: string, rate: number, load: AssetLoader, mediaType = 'audio/wav'): Promise<Pcm | null> {
  const key = `${hash}@${rate}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const blob = await load(hash);
      if (!blob) return null;
      const pcm = await decodeBytes(new Uint8Array(await blob.arrayBuffer()), mediaType);
      const out = shareable(resampleLinear(pcm, rate));
      cache.set(key, out);
      return out;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export function cachedPcmBytes(): number { let n = 0; for (const p of cache.values()) n += p.frames * p.channels.length * 4; return n; }
export function dropPcm(keep: Set<string>) { for (const k of [...cache.keys()]) if (!keep.has(k.split('@')[0])) cache.delete(k); }
export function peekPcm(hash: string, rate: number): Pcm | undefined { return cache.get(`${hash}@${rate}`); }
