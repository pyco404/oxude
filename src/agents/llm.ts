import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EDGES, MAX_ROUNDS, OXUDE_RULES, ROUNDS_TO_WIN, type Stakes } from "../round.js";
import { PRESETS, type PresetName } from "../presets.js";
import type { Agent } from "../types.js";
import {
  EDGE_KEYS,
  SITUATION_NOTES,
  SITUATIONS,
  describePolicy,
  policyAgent,
  validatePolicy,
  type Policy,
} from "./policy.js";

// A model fills the decision table once, before the match. The table is then an
// ordinary pure Agent, so the engine, the exact calculator and the balance
// criteria treat a model player exactly like a preset.

const MODEL = "claude-opus-5";
/** USD per million tokens for MODEL. */
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

const ActionSchema = z.enum(["fold", "call", "raise"]);
const RowSchema = z.object(Object.fromEntries(EDGE_KEYS.map((k) => [k, ActionSchema])) as Record<string, typeof ActionSchema>);
const PolicySchema = z.object(Object.fromEntries(SITUATIONS.map((s) => [s, RowSchema])) as Record<string, typeof RowSchema>);

export type PolicyCallLog = {
  model: string;
  /** What the model was shown, verbatim. */
  prompt: string;
  /** What it answered, verbatim, or null if nothing came back. */
  rawResponse: string | null;
  policy: Policy | null;
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number } | null;
  costUsd: number;
  latencyMs: number;
  /** Set when the preset fallback was used, with the reason. */
  fallback: { preset: PresetName; reason: string } | null;
};

export type ElicitOptions = {
  /** Anything to tell the model about who it is playing, in its own words. */
  brief?: string;
  stakes?: Stakes;
  /** Milliseconds before the call is abandoned and the fallback preset is used. Default 60s. */
  timeoutMs?: number;
  /** Used when the call fails, times out, or returns an unusable table. */
  fallbackPreset?: PresetName;
  client?: Anthropic;
  /** Receives one entry per elicitation, successful or not. */
  onLog?: (entry: PolicyCallLog) => void;
};

/** The rules, as the model needs to know them. */
export function buildPrompt(stakes: Stakes, brief?: string): string {
  return [
    `You are playing Oxude. Fill in a decision table; it will be played exactly as written.`,
    ``,
    `Each round both players privately draw an edge from ${EDGES.map((e) => e.toFixed(2)).join(", ")}.`,
    `Your edge is your chance of winning the round's coin flip against an unknown opponent draw;`,
    `if both edges are revealed, you win with probability 0.5 + yourEdge - theirEdge.`,
    `You see only your own edge. The opponent sees only theirs.`,
    ``,
    `One player acts first each round and the other answers; the lead alternates.`,
    `Actions are fold, call and raise. At most one raise per round.`,
    `If you fold you pay the ante of ${stakes.ante} and lose the round.`,
    `If neither folds the coin is flipped for ${stakes.baseBet}, or ${stakes.raisedBet} if either raised.`,
    `A match is up to ${MAX_ROUNDS} rounds and ends early at ${ROUNDS_TO_WIN} round wins. Money is what counts.`,
    ``,
    `Fill one action per edge for each of these situations:`,
    ...SITUATIONS.map((s) => `  ${s}: ${SITUATION_NOTES[s]}`),
    ``,
    `Edges, in order: ${EDGE_KEYS.join(", ")}.`,
    brief ? `\n${brief}` : ``,
  ].join("\n");
}

const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
const costOf = (u: PolicyCallLog["usage"]) =>
  u === null
    ? 0
    : (u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) /
      1_000_000;

/**
 * Asks the model for a policy once. Never throws and never hangs: on a timeout,
 * an API error or an unusable table it falls back to a preset and records why.
 */
export async function elicitPolicy(options: ElicitOptions = {}): Promise<{ agent: Agent; log: PolicyCallLog }> {
  const stakes = options.stakes ?? OXUDE_RULES.stakes;
  const fallbackPreset = options.fallbackPreset ?? "Anchor";
  const timeout = options.timeoutMs ?? 60_000;
  const client = options.client ?? new Anthropic();
  const prompt = buildPrompt(stakes, options.brief);
  const started = Date.now();

  const log: PolicyCallLog = {
    model: MODEL,
    prompt,
    rawResponse: null,
    policy: null,
    usage: null,
    costUsd: 0,
    latencyMs: 0,
    fallback: null,
  };

  try {
    const response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(PolicySchema) },
      },
      { timeout },
    );
    log.rawResponse = response.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
    log.usage = {
      input: response.usage.input_tokens ?? 0,
      output: response.usage.output_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
    };
    if (response.stop_reason === "refusal") throw new Error(`refused: ${response.stop_details?.category ?? "unknown"}`);
    log.policy = validatePolicy(response.parsed_output);
  } catch (error) {
    const reason =
      error instanceof Anthropic.APIError ? `${error.constructor.name}: ${error.message}` : String(error);
    log.fallback = { preset: fallbackPreset, reason };
  }

  log.usage ??= zero;
  log.costUsd = costOf(log.usage);
  log.latencyMs = Date.now() - started;
  options.onLog?.(log);
  return { agent: log.policy ? policyAgent(log.policy) : PRESETS[fallbackPreset], log };
}

/** Human-readable one-liner for a log entry. */
export const summariseCall = (log: PolicyCallLog) =>
  `${log.model} ${log.latencyMs}ms $${log.costUsd.toFixed(4)} ` +
  (log.fallback ? `FALLBACK -> ${log.fallback.preset} (${log.fallback.reason})` : `ok\n${describePolicy(log.policy!)}`);
