import { Keypair } from "@solana/web3.js";
import { mulberry32, nextUint32, PRESET_NAMES, PRESETS, type Agent, type Action } from "../src/index.js";
import { EDGE_KEYS, SITUATIONS, type Policy, type Situation } from "../src/agents/policy.js";

/** Agent that picks uniformly at random from its own seeded stream (independent of the match RNG). */
export function randomAgent(seed: number): Agent {
  const rng = mulberry32(seed);
  const actions: Action[] = ["fold", "call", "raise"];
  return () => actions[Math.floor(rng() * 3)]!;
}

export function constantAgent(action: Action): Agent {
  return () => action;
}

/** A pool mixing presets, constant agents and random agents. */
export function agentPool(seed: number): Agent[] {
  const rng = mulberry32(seed);
  return [
    ...PRESET_NAMES.map((n) => PRESETS[n]),
    constantAgent("fold"),
    constantAgent("call"),
    constantAgent("raise"),
    randomAgent(nextUint32(rng)),
    randomAgent(nextUint32(rng)),
  ];
}

/** A wallet key to own a test agent with. Agent ids are derived from it (src/agent-id.ts). */
export function someWallet(): string {
  return Keypair.generate().publicKey.toBase58();
}

/** A table from one row pattern per situation, written weakest edge first: "r c c c r". */
export function table(rows: Partial<Record<Situation, string>>, fallback = "c c c c c"): Policy {
  const letter = { f: "fold", c: "call", r: "raise" } as const;
  return Object.fromEntries(
    SITUATIONS.map((s) => {
      const acts = (rows[s] ?? fallback).split(" ").map((l) => letter[l as "f" | "c" | "r"]) as Action[];
      return [s, Object.fromEntries(EDGE_KEYS.map((k, i) => [k, acts[i]!]))];
    }),
  ) as Policy;
}
