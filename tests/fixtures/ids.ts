// 결정적 UUID 형태 ID — fixture 해시를 고정하기 위함.
export function fid(n: number, ns = 0): string {
  const h = (ns * 1_000_000 + n).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

/** mulberry32 seeded PRNG (05 §3 seed=20261022) */
export function rng(seed = 20261022): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
