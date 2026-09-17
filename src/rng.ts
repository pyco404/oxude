export type Rng = () => number;

/** mulberry32: small, fast, seeded 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a uint32, e.g. for deriving per-match seeds from a master PRNG. */
export function nextUint32(rng: Rng): number {
  return Math.floor(rng() * 4294967296) >>> 0;
}
