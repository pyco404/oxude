import { mulberry32 } from "../rng.js";
import { EDGE_KEYS, type Policy } from "../agents/policy.js";
import type { Expression } from "./draw.js";
import { reservedWord } from "./moderation.js";
import type { Style } from "./style.js";

/**
 * A character's name, epithet and bio, generated from its id and its table.
 * Templates, not a model: free, instant, and nothing in them can come out
 * unsafe, because every word was chosen here. Brief-written agents get a
 * model-written bio on top (src/character/model.ts); their name and epithet
 * still come from here.
 */

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Syllables chosen to sound like no language in particular and to spell no
// common word: names are invented, never borrowed.
const ONSETS = ["V", "K", "Th", "S", "M", "R", "D", "Z", "Qu", "Br", "Cal", "Mor", "Ves", "Tal", "Or", "Ix", "Ul", "Ny", "Sev", "Kor", "Hal", "Pell", "Dra", "Isk"];
const MIDDLES = ["a", "e", "i", "o", "u", "ae", "ei", "y", "ar", "en", "ir", "ol"];
const ENDS = ["r", "n", "th", "x", "ss", "l", "nd", "rk", "v", "sh", "ric", "mir", "vane", "dell", "wick", "rin", "ssa", "ko", "ven"];

/** An invented name, re-rolled until it is not in `taken` and claims nothing it shouldn't. */
export function characterName(agentId: string, taken: ReadonlySet<string> = new Set()): string {
  for (let salt = 0; salt < 500; salt++) {
    const rng = mulberry32(seedOf(`name#${agentId}#${salt}`));
    const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
    const parts = [pick(ONSETS), pick(MIDDLES)];
    if (rng() < 0.45) parts.push(pick(ONSETS).toLowerCase(), pick(MIDDLES));
    parts.push(pick(ENDS));
    const name = parts.join("");
    const lower = name.toLowerCase();
    if (name.length < 4 || name.length > 11) continue;
    if (/(.)\1\1/.test(lower)) continue; // no triple letters
    if (/[^aeiouy]{3,}/.test(lower.replace(/th|sh/g, "t"))) continue; // no clusters like "nrk"
    if (reservedWord(name)) continue;
    if ([...taken].some((t) => t.toLowerCase() === lower)) continue;
    return name;
  }
  throw new Error(`no unused name for ${agentId}`);
}

const ADJECTIVES: Record<Expression["mood"], string[]> = {
  calm: ["Quiet", "Patient", "Steady", "Unhurried", "Level", "Stone-Faced", "Slow"],
  fierce: ["Relentless", "Restless", "Burning", "Iron", "Headlong", "Sharp", "Loud"],
  sly: ["Two-Faced", "Smiling", "Crooked", "Velvet", "Slippery", "Double", "Painted"],
};
const WARY = ["Watchful", "Skittish", "Careful", "Wary"];
const NOUNS = ["Anvil", "Lantern", "Needle", "Tide", "Ember", "Gambit", "Mirror", "Hinge", "Compass", "Thorn", "Echo", "Bell", "Knot", "Wager", "Spark", "Cipher", "Cinder", "Latch"];

/** "the Quiet Anvil": the mood, and a noun for the individual. */
export function epithet(agentId: string, e: Expression): string {
  const rng = mulberry32(seedOf(`epithet#${agentId}`));
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
  const adjective = e.wary && e.mood !== "calm" && rng() < 0.5 ? pick(WARY) : pick(ADJECTIVES[e.mood]);
  return `the ${adjective} ${pick(NOUNS)}`;
}

/** What each character type is, in a few words. */
const WHAT: Record<string, string> = {
  theatre: "masked player",
  carnival: "carnival mask",
  porcelain: "porcelain-faced player",
  cracked: "cracked mask",
  plague: "beaked doctor",
  hooded: "hooded figure",
  visor: "visored android",
  antenna: "antennaed machine",
  screen: "screen-faced machine",
  battleworn: "battle-worn android",
  fox: "fox",
  wolf: "wolf",
  owl: "owl",
  raven: "raven",
  serpent: "serpent",
  boar: "boar",
  lynx: "lynx",
  shark: "shark",
  cat: "cat",
};

const TEMPERAMENT: Record<Expression["mood"], string[]> = {
  calm: ["that is never in a hurry", "with all the time in the world", "that nothing rattles", "that waits for the right hand"],
  fierce: ["that comes at every hand", "that likes the table loud", "that never lets a pot go quietly", "that plays as if the clock is running"],
  sly: ["that smiles most when it holds nothing", "that tells you what you want to hear", "whose best hand and worst look exactly alike", "that raises for reasons of its own"],
};

/** The lowest edge from which a row raises every stronger edge too, or null if it never does. */
function raisesFrom(row: Record<string, string>): string | null {
  const acts = EDGE_KEYS.map((k) => row[k]);
  for (let i = 0; i < acts.length; i++) if (acts.slice(i).every((a) => a === "raise")) return EDGE_KEYS[i]!;
  return null;
}
/** The lowest edge at which it calls a raise rather than folding. */
function callsRaiseFrom(row: Record<string, string>): string | null {
  const i = EDGE_KEYS.findIndex((k) => row[k] !== "fold");
  return i < 0 ? null : EDGE_KEYS[i]!;
}

const RAISE_WORDS: Record<string, string> = {
  "0.30": "raises every hand it is dealt",
  "0.40": "raises almost any hand",
  "0.50": "raises from even odds up",
  "0.60": "raises only a strong hand",
  "0.70": "raises only its very best",
};
const CALL_WORDS: Record<string, string> = {
  "0.30": "calls any raise",
  "0.40": "calls a raise with nearly anything",
  "0.50": "calls a raise from even odds up",
  "0.60": "folds to a raise unless it is strong",
  "0.70": "folds to a raise with all but its best",
};

/** How the table plays, fact by fact, in plain words. */
function playFacts(policy: Policy, s: Style) {
  const from = raisesFrom(policy.lead);
  const calls = callsRaiseFrom(policy.vsRaise);
  return {
    raise: from ? RAISE_WORDS[from]! : "never raises",
    bluff: s.bluff >= 0.5 ? "raises its weakest hands too, to steal the pot" : s.bluff > 0 ? "now and then raises a weak hand to steal" : null,
    call: calls ? CALL_WORDS[calls]! : "folds to every raise",
    pressure:
      s.pressure > 0.2 ? "raises more once raised at" : s.pressure < -0.2 ? "tightens up once raised at" : "plays the same whether or not it was raised at",
  };
}

/** How the table plays, as notes: what a bio writer is told about a brief-written agent. */
export function playNotes(policy: Policy, s: Style): string[] {
  const f = playFacts(policy, s);
  return [f.raise, ...(f.bluff ? [f.bluff] : []), f.call, f.pressure];
}

const PRESSURE_LINE = (s: Style, e: Expression): string =>
  s.pressure > 0.2
    ? "Pressure only makes it push harder."
    : e.wary
      ? "Raise back at it, though, and it backs down."
      : s.pressure < -0.2
        ? "Raise at it once and it tightens up."
        : "Raising at it changes nothing.";

/** Two or three sentences, from the character and what its table does. */
export function templateBio(agentId: string, name: string, type: string, policy: Policy, s: Style, e: Expression): string {
  const rng = mulberry32(seedOf(`bio#${agentId}`));
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
  const what = WHAT[type] ?? "player";
  const article = /^[aeiou]/i.test(what) ? "an" : "a";
  const f = playFacts(policy, s);
  const play = f.bluff ? `It ${f.raise}, ${f.bluff}, and ${f.call}.` : `It ${f.raise} and ${f.call}.`;
  return `${name} is ${article} ${what} ${pick(TEMPERAMENT[e.mood])}. ${play} ${PRESSURE_LINE(s, e)}`;
}
