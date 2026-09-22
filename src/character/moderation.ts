/**
 * Checks on what players and models write about characters: a name an owner
 * chose, and a bio a model wrote. No slurs or hate, nothing sexual, no real
 * people, nobody passing themselves off as the platform.
 *
 * Two layers. A local rule catches impersonation of Oxude itself, with no call
 * and no cost. Everything else goes to a small model check (src/character/
 * model.ts), which understands a slur spelled sideways or a name that belongs
 * to a real person in a way no word list can. When the model cannot be
 * reached, the text is let through marked unchecked - never passed silently.
 */

export type Verdict = {
  ok: boolean;
  /** Why not, in words an owner can act on. */
  reason: string | null;
  /** False when no model could be asked: accepted, but to be looked at. */
  checked: boolean;
};

/** Words that would make an agent look like it speaks for the platform. */
const RESERVED = ["oxude", "admin", "administrator", "official", "moderator", "support", "staff", "system"];

/**
 * Folds the usual look-alike characters, so "0xude" and "Adm1n" read as what
 * they are. "1", "!" and "|" stand for "i" as often as "l", so both readings
 * are returned.
 */
function fold(text: string): string[] {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/4|@/g, "a")
    .replace(/5|\$/g, "s")
    .replace(/7/g, "t");
  return ["i", "l"].map((ch) => base.replace(/[1!|]/g, ch).replace(/[^a-z]/g, ""));
}

/** The local rule: a reason if the text claims to be the platform, otherwise null. */
export function reservedWord(text: string): string | null {
  const readings = fold(text);
  // "Administrator" also contains "admin": report the longest word that was there.
  const hit = RESERVED.filter((w) => readings.some((r) => r.includes(w))).sort((a, b) => b.length - a.length)[0];
  return hit ? `names can't include "${hit}": it reads as speaking for Oxude` : null;
}

/** Plain limits on a name before anything is asked of a model. */
export function nameShape(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return "a name needs at least two characters";
  if (trimmed.length > 32) return "a name can be at most 32 characters";
  if (/[<>{}\u0000-\u001f]/.test(trimmed)) return "a name can't contain markup or control characters";
  return null;
}

/** What the model check has to offer. Injected, so tests and local runs need no network. */
export type TextCheck = (text: string, kind: "name" | "bio") => Promise<{ ok: boolean; reason: string | null }>;

/** The full check: shape, the local rule, then the model if there is one. */
export async function moderate(text: string, kind: "name" | "bio", check: TextCheck | null): Promise<Verdict> {
  const shape = kind === "name" ? nameShape(text) : null;
  if (shape) return { ok: false, reason: shape, checked: true };
  const reserved = reservedWord(text);
  if (reserved) return { ok: false, reason: reserved, checked: true };
  if (!check) return { ok: true, reason: null, checked: false };
  try {
    const verdict = await check(text, kind);
    return { ...verdict, checked: true };
  } catch {
    // The model is down or refused to answer: let it through, marked, rather than block a rental.
    return { ok: true, reason: null, checked: false };
  }
}
