// WAV(RIFF) 디코더/인코더. 디코딩 결과는 planar float32 (01 §6).
export interface Pcm { sampleRate: number; channels: Float32Array[]; frames: number }

export type WavFormat = 'wav-pcm24' | 'wav-float32' | 'wav-pcm16';

export function decodeWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('NOT_WAV');
  let p = 12; let fmt: { format: number; channels: number; rate: number; bits: number } | null = null; let data: [number, number] | null = null;
  while (p + 8 <= bytes.length) {
    const id = tag(p); const size = v.getUint32(p + 4, true); const body = p + 8;
    if (id === 'fmt ') {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE subformat
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') { data = [body, Math.min(size, bytes.length - body)]; }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV_MISSING_CHUNK');
  const { format, channels, rate, bits } = fmt;
  if (channels < 1 || channels > 2) throw new Error('WAV_CHANNELS_UNSUPPORTED');
  const bps = bits / 8; const frames = Math.floor(data[1] / (bps * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let o = data[0];
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++, o += bps) {
    let s: number;
    if (format === 3 && bits === 32) s = v.getFloat32(o, true);
    else if (format === 3 && bits === 64) s = v.getFloat64(o, true);
    else if (format === 1 && bits === 16) s = v.getInt16(o, true) / 32768;
    else if (format === 1 && bits === 24) { const x = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16); s = ((x << 8) >> 8) / 8388608; }
    else if (format === 1 && bits === 32) s = v.getInt32(o, true) / 2147483648;
    else if (format === 1 && bits === 8) s = (bytes[o] - 128) / 128;
    else throw new Error(`WAV_FORMAT_UNSUPPORTED ${format}/${bits}`);
    out[c][i] = s;
  }
  return { sampleRate: rate, channels: out, frames };
}

export function wavHeader(format: WavFormat, channels: number, sampleRate: number, frames: number): Uint8Array {
  const bits = format === 'wav-pcm24' ? 24 : format === 'wav-pcm16' ? 16 : 32;
  const fmtCode = format === 'wav-float32' ? 3 : 1;
  const dataBytes = frames * channels * (bits / 8);
  if (dataBytes + 36 > 0xffffffff) throw new Error('EXPORT_LIMIT: RIFF 4GiB');
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE');
  w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, fmtCode, true); h.setUint16(22, channels, true);
  h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * channels * (bits / 8), true);
  h.setUint16(32, channels * (bits / 8), true); h.setUint16(34, bits, true);
  w(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

export function wavDataBytes(format: WavFormat, channels: number, frames: number): number {
  return frames * channels * (format === 'wav-pcm24' ? 3 : format === 'wav-pcm16' ? 2 : 4);
}

/** 결정적 TPDF dither + clamp 로 interleave 인코딩 (01 §8). rng 는 [0,1) */
export function encodeBlock(format: WavFormat, chans: Float32Array[], frames: number, rng: () => number, stats?: { clipped: number }): Uint8Array {
  const nc = chans.length;
  const bps = format === 'wav-pcm24' ? 3 : format === 'wav-pcm16' ? 2 : 4;
  const out = new Uint8Array(frames * nc * bps);
  const v = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nc; c++) {
    const s = chans[c][i];
    if (format === 'wav-float32') { v.setFloat32(o, s, true); o += 4; continue; }
    const full = format === 'wav-pcm24' ? 8388608 : 32768;
    const d = (rng() - rng()); // TPDF ±1 LSB
    let q = Math.round(s * (full - 1) + d);
    if (q > full - 1) { q = full - 1; if (stats) stats.clipped++; }
    else if (q < -full) { q = -full; if (stats) stats.clipped++; }
    if (bps === 3) { out[o] = q & 255; out[o + 1] = (q >> 8) & 255; out[o + 2] = (q >> 16) & 255; }
    else v.setInt16(o, q, true);
    o += bps;
  }
  return out;
}

export function encodeWav(pcm: Pcm, format: WavFormat = 'wav-pcm16', rng: () => number = () => 0.5): Uint8Array {
  const h = wavHeader(format, pcm.channels.length, pcm.sampleRate, pcm.frames);
  const d = encodeBlock(format, pcm.channels, pcm.frames, rng);
  const out = new Uint8Array(h.length + d.length); out.set(h); out.set(d, h.length);
  return out;
}

/** mulberry32 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
