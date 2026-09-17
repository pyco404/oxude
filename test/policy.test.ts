import { describe, expect, it } from "vitest";
import {
  EDGES,
  expectedNet,
  InvalidPolicyError,
  OXUDE_RULES,
  playMatch,
  policyAgent,
  policyFromAgent,
  PRESET_NAMES,
  PRESETS,
  seatAveragedNet,
  situationOf,
  validatePolicy,
  type Policy,
  type View,
} from "../src/index.js";
import { buildPrompt, elicitPolicy, type PolicyCallLog } from "../src/agents/llm.js";
import type Anthropic from "@anthropic-ai/sdk";

const row = (a: string, b: string, c: string, d: string, e: string) =>
  Object.fromEntries(EDGES.map((edge, i) => [edge.toFixed(2), [a, b, c, d, e][i]]));
const POLICY = {
  lead: row("fold", "call", "call", "raise", "raise"),
  leadUnderPressure: row("fold", "fold", "call", "raise", "raise"),
  vsCall: row("call", "call", "call", "raise", "raise"),
  vsCallUnderPressure: row("fold", "call", "call", "raise", "raise"),
  vsRaise: row("fold", "fold", "call", "call", "call"),
  vsRaiseUnderPressure: row("fold", "fold", "call", "call", "call"),
} as unknown as Policy;

const view = (over: Partial<View> = {}): View => ({
  myEdge: 0.5,
  myRoundsWon: 0,
  oppRoundsWon: 0,
  roundNumber: 1,
  oppRaiseCount: 0,
  oppRaisedLastRound: false,
  stakes: OXUDE_RULES.stakes,
  myNet: 0,
  oppActionThisRound: null,
  myActionThisRound: null,
  ...over,
});

describe("policy agents", () => {
  it("maps a view to the right cell", () => {
    expect(situationOf(view())).toBe("lead");
    expect(situationOf(view({ oppRaisedLastRound: true }))).toBe("leadUnderPressure");
    expect(situationOf(view({ oppActionThisRound: "call" }))).toBe("vsCall");
    expect(situationOf(view({ oppActionThisRound: "call", oppRaisedLastRound: true }))).toBe("vsCallUnderPressure");
    expect(situationOf(view({ oppActionThisRound: "raise", oppRaisedLastRound: true }))).toBe("vsRaiseUnderPressure");
    const agent = policyAgent(POLICY);
    expect(agent(view({ myEdge: 0.3 }))).toBe("fold");
    expect(agent(view({ myEdge: 0.3, oppActionThisRound: "call" }))).toBe("call");
    expect(agent(view({ myEdge: 0.7 }))).toBe("raise");
  });

  it("is a pure function of the view, so the exact calculator can rate it", () => {
    const agent = policyAgent(POLICY);
    for (let k = 0; k < 50; k++) expect(agent(view({ myEdge: 0.4 }))).toBe(agent(view({ myEdge: 0.4 })));
    const a = expectedNet(agent, PRESETS.Bully);
    expect(expectedNet(agent, PRESETS.Bully)).toBe(a);
    expect(Number.isFinite(a)).toBe(true);
  });

  it("plays a real match and scores on the presets' scale", () => {
    const agent = policyAgent(POLICY);
    const log = playMatch(agent, PRESETS.Mirage, { seed: 7 });
    expect(log.nets.A + log.nets.B).toBe(0);
    const scores = PRESET_NAMES.map((n) => seatAveragedNet(agent, PRESETS[n]));
    expect(scores.every((s) => Math.abs(s) < 20)).toBe(true);
  });

  it("round-trips a preset through a policy table", () => {
    for (const name of PRESET_NAMES) {
      const snapshot = policyFromAgent(PRESETS[name], view());
      // Presets that read the stakes only differ per stakes, which the table fixes.
      expect(seatAveragedNet(policyAgent(snapshot), PRESETS[name])).toBeCloseTo(0, 9);
    }
  });

  it("rejects an unusable table and normalises a re-raise", () => {
    expect(() => validatePolicy({})).toThrow(InvalidPolicyError);
    expect(() => validatePolicy({ ...POLICY, vsCall: undefined })).toThrow(InvalidPolicyError);
    expect(() => validatePolicy({ ...POLICY, lead: { ...POLICY.lead, "0.30": "shove" } })).toThrow(InvalidPolicyError);
    const reRaise = validatePolicy({ ...POLICY, vsRaise: row("raise", "raise", "raise", "raise", "raise") } as unknown);
    expect(reRaise.vsRaise["0.30"]).toBe("call");
  });
});

/** Stands in for the SDK client so the tests never touch the network. */
function stubClient(behaviour: () => Promise<unknown>): Anthropic {
  return { messages: { parse: () => behaviour() } } as unknown as Anthropic;
}
const ok = (parsed: unknown, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: JSON.stringify(parsed) }],
  usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  stop_reason: "end_turn",
  parsed_output: parsed,
  ...extra,
});

describe("policy elicitation", () => {
  it("uses the model's table and logs tokens, cost and latency", async () => {
    const logs: PolicyCallLog[] = [];
    const { agent, log } = await elicitPolicy({ client: stubClient(async () => ok(POLICY)), onLog: (l) => logs.push(l) });
    expect(log.fallback).toBeNull();
    expect(agent(view({ myEdge: 0.7 }))).toBe("raise");
    expect(log.usage).toEqual({ input: 1200, output: 300, cacheWrite: 0, cacheRead: 0 });
    // 1200 in at $5/M + 300 out at $25/M.
    expect(log.costUsd).toBeCloseTo((1200 * 5 + 300 * 25) / 1_000_000, 12);
    expect(log.latencyMs).toBeGreaterThanOrEqual(0);
    expect(log.rawResponse).toContain("lead");
    expect(logs).toEqual([log]);
  });

  it.each([
    ["a timeout or API error", async () => Promise.reject(new Error("timed out")), /timed out/],
    ["an unusable table", async () => ok({ lead: {} }), /missing situation|not an action/],
    ["a refusal", async () => ok(POLICY, { stop_reason: "refusal", stop_details: { category: "cyber" } }), /refused/],
  ])("falls back to a named preset on %s, and records why", async (_label, behaviour, reason) => {
    const { agent, log } = await elicitPolicy({ client: stubClient(behaviour), fallbackPreset: "Hammer" });
    expect(log.fallback?.preset).toBe("Hammer");
    expect(log.fallback?.reason).toMatch(reason);
    expect(log.policy).toBeNull();
    // The match still gets a playable agent.
    for (const e of EDGES) expect(agent(view({ myEdge: e }))).toBe(PRESETS.Hammer(view({ myEdge: e })));
  });

  it("the prompt is a pure function of the stakes and brief, and leaks nothing", () => {
    const prompt = buildPrompt(OXUDE_RULES.stakes, "play tight");
    expect(prompt).toBe(buildPrompt(OXUDE_RULES.stakes, "play tight"));
    expect(prompt).toContain("You see only your own edge");
    expect(prompt).toContain("play tight");
    // Nothing about the opponent's draw, the coin roll or the seed.
    expect(prompt).not.toMatch(/seed|roll|opponent'?s edge is|their edge is/i);
  });
});
