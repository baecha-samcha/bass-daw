// 독립 SMF parser (X02) — midi-engine importMidi 를 사용하지 않는다.
export function parseSmf(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const s4 = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  if (s4(0) !== 'MThd') throw new Error('hdr');
  const format = v.getUint16(8), ntr = v.getUint16(10), division = v.getUint16(12);
  const tracks: { tick: number; status: number; data: number[]; meta?: number }[][] = [];
  let p = 14;
  for (let t = 0; t < ntr; t++) {
    if (s4(p) !== 'MTrk') throw new Error('trk');
    const len = v.getUint32(p + 4); let q = p + 8; const end = q + len; p = end;
    const evs: { tick: number; status: number; data: number[]; meta?: number }[] = []; let tick = 0, run = 0;
    const vl = () => { let n = 0, x; do { x = b[q++]; n = n * 128 + (x & 127); } while (x & 128); return n; };
    while (q < end) {
      tick += vl();
      let st = b[q]; if (st & 128) { q++; run = st; } else st = run;
      if (st === 0xff) { const m = b[q++]; const l = vl(); evs.push({ tick, status: st, meta: m, data: [...b.subarray(q, q + l)] }); q += l; continue; }
      const n = (st & 0xf0) === 0xc0 || (st & 0xf0) === 0xd0 ? 1 : 2;
      evs.push({ tick, status: st, data: [...b.subarray(q, q + n)] }); q += n;
    }
    tracks.push(evs);
  }
  return { format, ntr, division, tracks };
}
