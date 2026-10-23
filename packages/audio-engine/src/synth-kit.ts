// 자체 합성 샘플 키트 — 재배포 허용(라이선스: self-synthesized, CC0 상당). 전문 음질을 주장하지 않는다.
// seed=20261022 로 결정적이며 content hash 가 고정된다.
import { encodeWav, seededRng, type Pcm } from './wav.ts';

export const KIT_SAMPLE_RATE = 48000;
export interface KitSample { key: string; role: 'zone' | 'pad'; articulation: string; rootPitch: number; minPitch: number; maxPitch: number; padName?: string; bytes: Uint8Array }

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function pluck(rng: () => number, freq: number, seconds: number, damping: number, bright: number): Float32Array {
  // Karplus-Strong
  const sr = KIT_SAMPLE_RATE; const n = Math.round(sr * seconds); const out = new Float32Array(n);
  const period = Math.max(2, Math.round(sr / freq)); const buf = new Float32Array(period);
  for (let i = 0; i < period; i++) buf[i] = (rng() * 2 - 1) * (bright + (1 - bright) * Math.sin((Math.PI * i) / period));
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[p], b = buf[(p + 1) % period];
    out[i] = a;
    buf[p] = damping * 0.5 * (a + b);
    p = (p + 1) % period;
  }
  return normalize(out, 0.8);
}

function keys(freq: number, seconds: number): Float32Array {
  const sr = KIT_SAMPLE_RATE; const n = Math.round(sr * seconds); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr; const env = Math.exp(-t * 1.6) * Math.min(1, t * 400);
    const mod = Math.sin(2 * Math.PI * freq * 2 * t) * 1.2 * Math.exp(-t * 4);
    out[i] = env * (0.7 * Math.sin(2 * Math.PI * freq * t + mod) + 0.2 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 3));
  }
  return normalize(out, 0.7);
}

function drum(rng: () => number, kind: string): Float32Array {
  const sr = KIT_SAMPLE_RATE;
  const len = { kick: 0.5, snare: 0.35, chh: 0.08, ohh: 0.6, ltom: 0.5, htom: 0.4, crash: 1.6, ride: 1.2 }[kind] ?? 0.5;
  const n = Math.round(sr * len); const out = new Float32Array(n);
  let hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; const noise = rng() * 2 - 1;
    hp = 0.6 * (hp + noise - prev); prev = noise; // 1차 high-pass
    switch (kind) {
      case 'kick': { const f = 45 + 110 * Math.exp(-t * 30); out[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) + noise * 0.05 * Math.exp(-t * 200); break; }
      case 'snare': out[i] = 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 18) + 0.6 * noise * Math.exp(-t * 14); break;
      case 'chh': out[i] = hp * Math.exp(-t * 60); break;
      case 'ohh': out[i] = hp * Math.exp(-t * 5); break;
      case 'ltom': out[i] = Math.sin(2 * Math.PI * (90 + 40 * Math.exp(-t * 10)) * t) * Math.exp(-t * 8); break;
      case 'htom': out[i] = Math.sin(2 * Math.PI * (150 + 50 * Math.exp(-t * 10)) * t) * Math.exp(-t * 9); break;
      case 'crash': out[i] = hp * Math.exp(-t * 2.2) * 0.8; break;
      case 'ride': out[i] = (hp * 0.4 + 0.3 * Math.sin(2 * Math.PI * 3200 * t)) * Math.exp(-t * 3); break;
    }
  }
  return normalize(out, 0.8);
}

function normalize(x: Float32Array, to: number): Float32Array {
  let m = 0; for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= to / m;
  // 끝 5ms fade-out
  const f = Math.round(KIT_SAMPLE_RATE * 0.005);
  for (let i = 0; i < f && i < x.length; i++) x[x.length - 1 - i] *= i / f;
  return x;
}

const pcmOf = (x: Float32Array): Pcm => ({ sampleRate: KIT_SAMPLE_RATE, channels: [x], frames: x.length });

export type KitName = 'bass' | 'guitar' | 'keys' | 'drums';

/** 각 키트의 sample WAV(PCM16 mono). zone 은 root 기준 ±3 반음 범위. */
export function synthKit(kit: KitName): KitSample[] {
  const rng = seededRng(20261022 + ['bass', 'guitar', 'keys', 'drums'].indexOf(kit));
  const out: KitSample[] = [];
  const zoneSet = (roots: number[], art: string, make: (root: number) => Float32Array) => roots.forEach((r, i) => {
    const lo = i === 0 ? 0 : r - 3, hi = i === roots.length - 1 ? 127 : r + 2;
    out.push({ key: `${kit}-${art}-${r}`, role: 'zone', articulation: art, rootPitch: r, minPitch: lo, maxPitch: hi, bytes: encodeWav(pcmOf(make(r))) });
  });
  if (kit === 'bass') {
    const roots = [28, 34, 40, 46, 52, 58];
    zoneSet(roots, 'normal', (r) => pluck(rng, mtof(r), 2.0, 0.996, 0.3));
    zoneSet(roots, 'mute', (r) => pluck(rng, mtof(r), 0.35, 0.95, 0.1));
    zoneSet(roots, 'slap', (r) => pluck(rng, mtof(r), 1.5, 0.993, 1.0));
  } else if (kit === 'guitar') {
    const roots = [40, 46, 52, 58, 64, 70, 76];
    zoneSet(roots, 'normal', (r) => pluck(rng, mtof(r), 2.5, 0.997, 0.7));
    zoneSet(roots, 'mute', (r) => pluck(rng, mtof(r), 0.25, 0.93, 0.4));
  } else if (kit === 'keys') {
    zoneSet([36, 42, 48, 54, 60, 66, 72, 78, 84], 'normal', (r) => keys(mtof(r), 2.5));
  } else {
    for (const [name, pitch] of [['kick', 36], ['snare', 38], ['chh', 42], ['ohh', 46], ['ltom', 45], ['htom', 50], ['crash', 49], ['ride', 51]] as const) {
      out.push({ key: `drums-${name}`, role: 'pad', articulation: 'normal', rootPitch: pitch, minPitch: pitch, maxPitch: pitch, padName: name, bytes: encodeWav(pcmOf(drum(rng, name))) });
    }
  }
  return out;
}

export const KIT_LICENSE = { name: 'bass-daw self-synthesized (redistributable)', origin: 'generated by @bass-daw/audio-engine synth-kit seed 20261022', redistribution: 'allowed' as const };
