import { describe, it, expect } from 'vitest';
import { buildPyramid, serializePyramid, deserializePyramid, pickLevel } from '@bass-daw/audio-engine';

describe('waveform pyramid (01 §7)', () => {
  it('min/max per 256/1024/4096/16384 frames, independent of source mutation', () => {
    const n = 100_000; const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(i / 50) * (i < 50_000 ? 0.5 : 1);
    const p = buildPyramid([x], 48000);
    expect(p.levels.map((l) => l.bucket)).toEqual([256, 1024, 4096, 16384]);
    expect(p.levels[0].min.length).toBe(Math.ceil(n / 256));
    // 독립 계산
    let mn = Infinity, mx = -Infinity; for (let i = 1024 * 3; i < 1024 * 4; i++) { mn = Math.min(mn, x[i]); mx = Math.max(mx, x[i]); }
    expect(p.levels[1].min[3]).toBeCloseTo(mn, 6); expect(p.levels[1].max[3]).toBeCloseTo(mx, 6);
    const back = deserializePyramid(serializePyramid(p));
    expect(Array.from(back.levels[3].max)).toEqual(Array.from(p.levels[3].max));
    expect(pickLevel(p, 5000).bucket).toBe(4096);
  });
});
