// 독립 WAV byte parser (X01) — 엔진의 decodeWav 를 사용하지 않는다.
export function parseWav(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const s4 = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  if (s4(0) !== 'RIFF' || s4(8) !== 'WAVE' || s4(12) !== 'fmt ' || s4(36) !== 'data') throw new Error('layout');
  const fmt = v.getUint16(20, true), ch = v.getUint16(22, true), rate = v.getUint32(24, true), byteRate = v.getUint32(28, true), align = v.getUint16(32, true), bits = v.getUint16(34, true);
  const dataLen = v.getUint32(40, true), riffLen = v.getUint32(4, true);
  const frames = dataLen / align;
  const sample = (frame: number, c: number): number => {
    const o = 44 + frame * align + c * (bits / 8);
    if (fmt === 3) return v.getFloat32(o, true);
    if (bits === 24) { const x = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); return (x << 8) >> 8; }
    if (bits === 16) return v.getInt16(o, true);
    throw new Error('fmt');
  };
  return { fmt, ch, rate, byteRate, align, bits, dataLen, riffLen, frames, sample, total: b.length };
}
