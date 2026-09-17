/**
 * Agent names: one distinctive word and a number, e.g. Ashvault-4417.
 * The word carries the character, the number keeps names apart. No preset in
 * the name: a ladder full of "Mirage-" tells a reader nothing and reads as
 * filler.
 */
const WORDS = [
  "Ashvault", "Blackfen", "Coldharbour", "Dustline", "Emberwick", "Farrow", "Glasswing", "Hollowmere",
  "Ironvale", "Jackdaw", "Kestrel", "Lanternfish", "Marrowgate", "Nightjar", "Oxbow", "Pitchfork",
  "Quarrel", "Rooksfoot", "Saltmarsh", "Tallowmoor", "Underhill", "Vesper", "Wolfsbane", "Yarrow",
  "Zephyrline", "Bramblewick", "Cinderfell", "Drywater", "Eastgrave", "Flintlock", "Goldbarrow",
  "Harrowdown", "Inkwell", "Jetsam", "Kilnstone", "Longshadow", "Mudlark", "Netherfield", "Oakenshaw",
  "Pennyroyal", "Ravenscar", "Stonecrop", "Thistledown", "Umberfield", "Vantage", "Whitethorn",
] as const;

export type Rng = () => number;

/** A name generator that never repeats itself, given the same instance. */
export function nameFactory(rng: Rng) {
  const used = new Set<string>();
  return function nextName(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      const word = WORDS[Math.floor(rng() * WORDS.length)]!;
      const number = 100 + Math.floor(rng() * 9900);
      const name = `${word}-${number}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
    throw new Error("ran out of distinct names");
  };
}

export { WORDS };
