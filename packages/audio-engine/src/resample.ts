// 자산 PCM 을 실제 컨텍스트 rate 로 변환(01 §3). v1 은 선형 보간 — high profile 품질은 계측 후 선택(01 §6).
import type { Pcm } from './wav.ts';

export function resampleLinear(pcm: Pcm, targetRate: number): Pcm {
  if (pcm.sampleRate === targetRate) return pcm;
  const ratio = pcm.sampleRate / targetRate;
  const frames = Math.max(1, Math.round(pcm.frames / ratio));
  const channels = pcm.channels.map((src) => {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const x = i * ratio; const i0 = Math.floor(x); const f = x - i0;
      const a = src[Math.min(i0, src.length - 1)], b = src[Math.min(i0 + 1, src.length - 1)];
      out[i] = a + (b - a) * f;
    }
    return out;
  });
  return { sampleRate: targetRate, channels, frames };
}

export function pcmBytes(p: Pcm): number { return p.frames * p.channels.length * 4; }
