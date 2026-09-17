import { EDGES } from "../round.js";
import type { Action, Agent, View } from "../types.js";

/**
 * A policy is a filled-in decision table: one action per situation per edge.
 * It is data, so an agent built from it is a pure function of the view, which
 * is what lets the exact calculator rate a model on the same scale as the
 * presets.
 */
export const SITUATIONS = [
  "lead",
  "leadUnderPressure",
  "vsCall",
  "vsCallUnderPressure",
  "vsRaise",
  "vsRaiseUnderPressure",
] as const;
export type Situation = (typeof SITUATIONS)[number];

/** Edges as table keys: "0.30" .. "0.70". */
export const EDGE_KEYS = EDGES.map((e) => e.toFixed(2)) as readonly string[];
export const edgeKey = (edge: number) => edge.toFixed(2);

export type Policy = Record<Situation, Record<string, Action>>;

export const SITUATION_NOTES: Record<Situation, string> = {
  lead: "you act first this round",
  leadUnderPressure: "you act first, and the opponent raised in the previous round",
  vsCall: "the opponent acted first and called",
  vsCallUnderPressure: "the opponent called, and also raised in the previous round",
  vsRaise: "the opponent has raised this round; you may only fold or call",
  vsRaiseUnderPressure: "the opponent has raised this round, and also raised in the previous one",
};

/** Which cell a view falls into. */
export function situationOf(view: View): Situation {
  const pressured = view.oppRaisedLastRound;
  if (view.oppActionThisRound === "raise") return pressured ? "vsRaiseUnderPressure" : "vsRaise";
  if (view.oppActionThisRound === "call") return pressured ? "vsCallUnderPressure" : "vsCall";
  return pressured ? "leadUnderPressure" : "lead";
}

/** Wraps a filled table as an ordinary Agent. Pure: same view, same action. */
export function policyAgent(policy: Policy): Agent {
  const table = validatePolicy(policy);
  return (view) => table[situationOf(view)][edgeKey(view.myEdge)]!;
}

export class InvalidPolicyError extends Error {}

/** Checks every cell exists and holds a legal action; returns a frozen copy. */
export function validatePolicy(policy: unknown): Policy {
  if (typeof policy !== "object" || policy === null) throw new InvalidPolicyError("policy is not an object");
  const out = {} as Policy;
  for (const situation of SITUATIONS) {
    const row = (policy as Record<string, unknown>)[situation];
    if (typeof row !== "object" || row === null) throw new InvalidPolicyError(`missing situation ${situation}`);
    const cells: Record<string, Action> = {};
    for (const key of EDGE_KEYS) {
      const action = (row as Record<string, unknown>)[key];
      if (action !== "fold" && action !== "call" && action !== "raise") {
        throw new InvalidPolicyError(`${situation}.${key} is not an action: ${String(action)}`);
      }
      // Facing a raise there is no re-raise; treat one as a call rather than rejecting.
      cells[key] = situation.startsWith("vsRaise") && action === "raise" ? "call" : action;
    }
    out[situation] = Object.freeze(cells);
  }
  return Object.freeze(out);
}

/** Reads an existing agent's table, e.g. to seed a prompt or snapshot a preset. */
export function policyFromAgent(agent: Agent, view: Omit<View, "myEdge" | "oppActionThisRound" | "oppRaisedLastRound">): Policy {
  const rows = {} as Policy;
  for (const situation of SITUATIONS) {
    const cells: Record<string, Action> = {};
    for (const edge of EDGES) {
      const facingRaise = situation.startsWith("vsRaise");
      cells[edgeKey(edge)] = agent({
        ...view,
        myEdge: edge,
        oppRaisedLastRound: situation.endsWith("UnderPressure"),
        oppActionThisRound: situation.startsWith("vsCall") ? "call" : facingRaise ? "raise" : null,
        myActionThisRound: facingRaise ? "call" : null,
      });
    }
    rows[situation] = cells;
  }
  return validatePolicy(rows);
}

/** One line per situation, e.g. "lead: c c c r r". */
export function describePolicy(policy: Policy): string {
  return SITUATIONS.map((s) => `${s}: ${EDGE_KEYS.map((k) => policy[s][k]![0]).join(" ")}`).join("\n");
}
