import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, characters, type AgentRow } from "../db/schema.js";
import { PORTRAIT_VERSION, portrait, uniquePortrait } from "./portrait.js";
import { characterName, epithet, playNotes, templateBio } from "./identity.js";
import { moderate, type TextCheck, type Verdict } from "./moderation.js";
import type { BioWriter } from "./model.js";

/**
 * Making and reading characters. Lives on the character side of the wall:
 * nothing that plays or pays imports this (test/character-isolation.test.ts).
 */

/** The model calls a character may use. Both optional: without them, templates and the local rules. */
export type CharacterDeps = { check: TextCheck | null; writeBio: BioWriter | null };
export const NO_MODEL: CharacterDeps = { check: null, writeBio: null };

export type CharacterRow = typeof characters.$inferSelect;

/**
 * A name nobody chose: what the rent screen filled in when the box was left
 * empty. These are replaced with a generated name, since there is nothing of
 * the owner's in them to keep.
 */
export const isDefaultName = (name: string): boolean => /^(Anchor|Hammer|Mirage|Bully) rental$|^My agent$/i.test(name.trim());

/** Every face and look already taken, so a new one can be kept apart from them. */
async function takenLooks(db: Db): Promise<Set<string>> {
  const rows = await db.select({ f: characters.fingerprint, l: characters.lookKey }).from(characters);
  return new Set(rows.flatMap((r) => [r.f, r.l]));
}
async function takenNames(db: Db): Promise<Set<string>> {
  return new Set((await db.select({ name: agents.name }).from(agents)).map((r) => r.name));
}

export type CreateOptions = {
  deps?: CharacterDeps;
  /** The owner's name has already been checked at rent; this records how. */
  nameVerdict?: Verdict;
};

/**
 * Gives an agent its character, once: portrait, and a generated name unless
 * the owner chose one, an epithet and a bio. Harmless to call again - an agent
 * that has a character keeps it. A face another agent takes at the same moment
 * is caught by the unique fingerprint and re-rolled.
 */
export async function createCharacter(db: Db, agentId: string, options: CreateOptions = {}): Promise<CharacterRow> {
  const deps = options.deps ?? NO_MODEL;
  const [existing] = await db.select().from(characters).where(eq(characters.agentId, agentId));
  if (existing) return existing;
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new Error(`no agent ${agentId}`);
  if (!agent.policyTable) throw new Error(`agent ${agentId} has no table to draw a face from`);

  const v = options.nameVerdict;
  const ownerGaveOne = agent.ownerId !== null && !isDefaultName(agent.name) && v !== undefined;
  // A chosen name that could not be checked is not shown in public yet: the
  // agent goes by a generated name, its owner sees the chosen one as pending,
  // and recheckNames switches it over once it passes.
  const pending = ownerGaveOne && v.ok && !v.checked ? agent.name : null;
  // Named by its owner, unless the name is one the rent screen filled in or is still waiting.
  const chosen = ownerGaveOne && pending === null;
  const name = chosen ? agent.name : characterName(agentId, await takenNames(db));
  // A name that failed its check at rent never gets this far - it is refused.
  // One that fails in the backfill is kept but flagged, for a person to decide:
  // the backfill does not rename what an owner chose.
  let flagged: string | null = v && !v.ok ? `name failed its check: ${v.reason ?? "no reason given"}` : null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const face = uniquePortrait(agentId, agent.policyTable, await takenLooks(db));
    const title = epithet(agentId, face.expression);
    let bio = templateBio(agentId, name, face.features.type, agent.policyTable, face.style, face.expression);
    let bioSource: "template" | "model" = "template";
    // A brief-written agent gets a bio written for it, from its table - never the brief's own words.
    if (agent.brief && deps.writeBio) {
      const written = await deps
        .writeBio({ name, epithet: title, character: face.features.type, mood: face.expression.mood, play: playNotes(agent.policyTable, face.style).join("\n") })
        .catch(() => null);
      if (written) {
        const verdict = await moderate(written, "bio", deps.check);
        if (verdict.ok) {
          bio = written;
          bioSource = "model";
          if (!verdict.checked) flagged ??= "bio not checked: the model could not be reached";
        }
      }
    }
    try {
      return await db.transaction(async (tx) => {
        if (!chosen) await tx.update(agents).set({ name }).where(eq(agents.id, agentId));
        const [row] = await tx
          .insert(characters)
          .values({
            agentId,
            nameSource: chosen ? "owner" : "generated",
            epithet: title,
            bio,
            bioSource,
            portraitVersion: PORTRAIT_VERSION,
            portraitSvg: face.svg,
            portraitSmallSvg: face.svgSmall,
            fingerprint: face.fingerprint,
            lookKey: face.lookKey,
            characterType: face.features.type,
            moderation: flagged ? "flagged" : pending ? "pending" : "ok",
            moderationNote: flagged ?? (pending ? "chosen name waiting for its check" : null),
            pendingName: pending,
          })
          .returning();
        return row!;
      });
    } catch (error) {
      // Someone took this face in the moment between choosing and saving: choose again.
      if (/characters_fingerprint_unique|duplicate key|23505/.test(String((error as { cause?: unknown }).cause ?? error))) continue;
      // Or this agent got its character from a second request first.
      const [raced] = await db.select().from(characters).where(eq(characters.agentId, agentId));
      if (raced) return raced;
      throw error;
    }
  }
  throw new Error(`could not give ${agentId} a unique face`);
}

export async function characterOf(db: Db, agentId: string): Promise<CharacterRow | undefined> {
  const [row] = await db.select().from(characters).where(eq(characters.agentId, agentId));
  return row;
}

/**
 * Checks every chosen name still waiting, now that the check may be reachable
 * again. A name that passes becomes the agent's name; one that fails stays off
 * the agent and is flagged with the reason. A check that still cannot be made
 * leaves it waiting for the next pass.
 */
export async function recheckNames(db: Db, check: TextCheck | null): Promise<{ switched: string[]; refused: string[] }> {
  const waiting = await db.select().from(characters).where(sql`${characters.pendingName} is not null`);
  const switched: string[] = [];
  const refused: string[] = [];
  for (const c of waiting) {
    const verdict = await moderate(c.pendingName!, "name", check);
    if (!verdict.checked) continue;
    await db.transaction(async (tx) => {
      if (verdict.ok) {
        await tx.update(agents).set({ name: c.pendingName! }).where(eq(agents.id, c.agentId));
        await tx
          .update(characters)
          .set({ nameSource: "owner", pendingName: null, moderation: "ok", moderationNote: null })
          .where(eq(characters.agentId, c.agentId));
      } else {
        await tx
          .update(characters)
          .set({ pendingName: null, moderation: "flagged", moderationNote: `chosen name "${c.pendingName}" failed its check: ${verdict.reason ?? "no reason given"}` })
          .where(eq(characters.agentId, c.agentId));
      }
    });
    (verdict.ok ? switched : refused).push(c.agentId);
  }
  return { switched, refused };
}

/** Keeps re-checking waiting names, every five minutes. */
export function startNameChecks(db: Db, check: TextCheck, options: { onLog?: (line: string) => void; onError?: (e: unknown) => void } = {}): { stop: () => void } {
  const timer = setInterval(() => {
    recheckNames(db, check)
      .then((r) => {
        if (r.switched.length || r.refused.length) options.onLog?.(`names: ${r.switched.length} chosen names passed their check, ${r.refused.length} refused`);
      })
      .catch((e: unknown) => options.onError?.(e));
  }, 5 * 60_000);
  return { stop: () => clearInterval(timer) };
}

/** What the owner sees and no one else: a chosen name still waiting for its check. */
export const ownerCharacter = (c: CharacterRow) => ({ ...publicCharacter(c), pendingName: c.pendingName });

/** What anyone may see of a character. */
export const publicCharacter = (c: CharacterRow) => ({
  epithet: c.epithet,
  bio: c.bio,
  type: c.characterType,
  nameSource: c.nameSource,
});

/**
 * An agent's portrait: the stored one, or - for an agent created since the
 * last backfill and not yet given a character - drawn now from its id and
 * table, without storing it. Never missing.
 */
export async function portraitSvg(db: Db, agent: Pick<AgentRow, "id" | "policyTable">, small: boolean): Promise<string | null> {
  const [row] = await db
    .select({ large: characters.portraitSvg, small: characters.portraitSmallSvg })
    .from(characters)
    .where(eq(characters.agentId, agent.id));
  if (row) return small ? row.small : row.large;
  if (!agent.policyTable) return null;
  const p = portrait(agent.id, agent.policyTable);
  return small ? p.svgSmall : p.svg;
}

/** How many agents have no character yet: the backfill's to-do list. */
export async function agentsWithoutCharacter(db: Db): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(sql`not exists (select 1 from ${characters} where ${characters.agentId} = ${agents.id})`)
    .orderBy(agents.createdAt);
}
