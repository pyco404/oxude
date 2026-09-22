import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { TextCheck } from "./moderation.js";

/**
 * The small model calls characters use: checking a name or bio, and writing a
 * bio for an agent whose table came from a brief. Haiku, because both are
 * short, bounded jobs and a rental should not wait on anything bigger.
 *
 * The bio is written from the table and a plain summary of it - never the
 * brief's own words, so a real name or an instruction in a brief cannot find
 * its way into a character.
 */

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 15_000;

const CheckSchema = z.object({
  verdict: z.enum(["ok", "slur_or_hate", "sexual", "real_person", "impersonation", "other"]),
  reason: z.string(),
});

const WHY: Record<z.infer<typeof CheckSchema>["verdict"], string> = {
  ok: "",
  slur_or_hate: "it reads as a slur or as hateful",
  sexual: "it's sexual",
  real_person: "it names or points at a real person",
  impersonation: "it passes itself off as someone it isn't",
  other: "it isn't suitable for a public name",
};

export function textCheck(client: Anthropic = new Anthropic()): TextCheck {
  return async (text, kind) => {
    const response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: 400,
        system:
          `You review what players write for a public game where AI agents play each other. ` +
          `Judge one ${kind === "name" ? "display name for an agent" : "short character bio"}. ` +
          `It is fine for it to be invented, playful, menacing or strange. ` +
          `Reject it only if it is a slur or hateful, sexual, names or clearly points at a real, identifiable person (living or dead), ` +
          `or impersonates a company, brand or the game's staff. Existing fictional characters count as "other".`,
        messages: [{ role: "user", content: `The ${kind}, between the markers:\n<<<\n${text}\n>>>` }],
        output_config: { format: zodOutputFormat(CheckSchema) },
      },
      { timeout: TIMEOUT_MS },
    );
    if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("no verdict");
    const { verdict } = response.parsed_output;
    return verdict === "ok" ? { ok: true, reason: null } : { ok: false, reason: `can't use that ${kind}: ${WHY[verdict]}` };
  };
}

const BioSchema = z.object({ bio: z.string() });

export type BioWriter = (input: { name: string; epithet: string; character: string; mood: string; play: string }) => Promise<string | null>;

/** A two- or three-sentence bio from what the table does. Null when the model gives nothing usable. */
export function bioWriter(client: Anthropic = new Anthropic()): BioWriter {
  return async ({ name, epithet, character, mood, play }) => {
    const response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: 600,
        system:
          `You write character bios for agents in a card-and-bluff game. Two or three short sentences, third person, ` +
          `vivid and specific to how this agent plays. Wholly original: no real people, no existing fictional characters, ` +
          `no brands, and no mention of AI, models or prompts. Under 60 words.`,
        messages: [
          {
            role: "user",
            content: `Name: ${name}, ${epithet}\nLooks like: a ${character}, with a ${mood} expression\nHow it plays:\n${play}`,
          },
        ],
        output_config: { format: zodOutputFormat(BioSchema) },
      },
      { timeout: TIMEOUT_MS },
    );
    if (response.stop_reason === "refusal") return null;
    const bio = response.parsed_output?.bio.trim();
    return bio && bio.length >= 20 && bio.length <= 480 ? bio : null;
  };
}
