// 파형 min/max 피라미드 (01 §7): 256/1024/4096/16384 source frames per bucket. 파형은 캐시이며 원본이 아니다.
export const WAVEFORM_LEVELS = [256, 1024, 4096, 16384] as const;
export interface WaveformPyramid { frames: number; sampleRate: number; levels: { bucket: number; min: Float32Array; max: Float32Array }[] }

export function buildPyramid(channels: Float32Array[], sampleRate: number): WaveformPyramid {
  const frames = channels[0]?.length ?? 0;
  const base: number = WAVEFORM_LEVELS[0];
  const n0 = Math.ceil(frames / base);
  const min0 = new Float32Array(n0).fill(Infinity), max0 = new Float32Array(n0).fill(-Infinity);
  for (const ch of channels) for (let i = 0; i < frames; i++) {
    const b = (i / base) | 0; const v = ch[i];
    if (v < min0[b]) min0[b] = v; if (v > max0[b]) max0[b] = v;
  }
  for (let b = 0; b < n0; b++) if (min0[b] === Infinity) { min0[b] = 0; max0[b] = 0; }
  const levels: WaveformPyramid['levels'] = [{ bucket: base, min: min0, max: max0 }];
  for (let l = 1; l < WAVEFORM_LEVELS.length; l++) {
    const prev = levels[l - 1]; const f = WAVEFORM_LEVELS[l] / WAVEFORM_LEVELS[l - 1];
    const n = Math.ceil(prev.min.length / f);
    const mn = new Float32Array(n), mx = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let a = Infinity, z = -Infinity;
      for (let j = b * f; j < Math.min(prev.min.length, (b + 1) * f); j++) { if (prev.min[j] < a) a = prev.min[j]; if (prev.max[j] > z) z = prev.max[j]; }
      mn[b] = a === Infinity ? 0 : a; mx[b] = z === -Infinity ? 0 : z;
    }
    levels.push({ bucket: WAVEFORM_LEVELS[l], min: mn, max: mx });
  }
  return { frames, sampleRate, levels };
}

export function serializePyramid(p: WaveformPyramid): Uint8Array {
  const total = p.levels.reduce((s, l) => s + l.min.length * 2, 0);
  const out = new Float32Array(4 + total);
  out[0] = p.frames; out[1] = p.sampleRate; out[2] = p.levels.length; out[3] = 1;
  let o = 4;
  for (const l of p.levels) { out.set(l.min, o); o += l.min.length; out.set(l.max, o); o += l.max.length; }
  return new Uint8Array(out.buffer);
}

export function deserializePyramid(b: Uint8Array): WaveformPyramid {
  const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const frames = f[0], sampleRate = f[1];
  let o = 4; const levels: WaveformPyramid['levels'] = [];
  for (const bucket of WAVEFORM_LEVELS) {
    const n = Math.ceil(frames / bucket);
    levels.push({ bucket, min: f.slice(o, o + n), max: f.slice(o + n, o + 2 * n) }); o += 2 * n;
  }
  return { frames, sampleRate, levels };
}

/** 표시 폭에 맞는 레벨 선택 */
export function pickLevel(p: WaveformPyramid, framesPerPixel: number) {
  let best = p.levels[0];
  for (const l of p.levels) if (l.bucket <= framesPerPixel) best = l;
  return best;
}
