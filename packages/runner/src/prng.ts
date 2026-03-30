/**
 * Mulberry32 — simple, fast, seedable 32-bit PRNG.
 * Returns a function that produces [0, 1) on each call (same interface as Math.random).
 */
export function createPrng(seed: number): () => number {
  let s = seed | 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
