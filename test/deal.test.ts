import { describe, expect, it } from "vitest";
import {
  complementEdge,
  dealOutcomes,
  decideRound,
  EDGES,
  expectedNet,
  freezeStakes,
  CLASSIC_STAKES,
  initialState,
  mulberry32,
  nextUint32,
  playMatch,
  PRESET_NAMES,
  PRESETS,
  winProbabilityA,
  type Agent,
  type MatchLog,
  type TurnOrder,
  type View,
} from "../src/index.js";
import { agentPool, constantAgent } from "./helpers.js";

const independent = { deal: "independent" } as const;

describe("deals", () => {
  it("complementary is the default and is recorded in the log", () => {
    const log = playMatch(PRESETS.Hammer, PRESETS.Bully, { seed: 1 });
    expect(log.deal).toBe("complementary");
    expect(log.rounds.every((r) => r.edges.B === complementEdge(r.edges.A))).toBe(true);
    expect(playMatch(PRESETS.Hammer, PRESETS.Bully, { seed: 1, ...independent }).deal).toBe("independent");
  });

  it("outcome tables cover every pair once, with probabilities summing to 1", () => {
    const comp = dealOutcomes("complementary");
    const ind = dealOutcomes("independent");
    expect(comp).toHaveLength(EDGES.length);
    expect(ind).toHaveLength(EDGES.length ** 2);
    expect(new Set(ind.map((o) => `${o.A},${o.B}`)).size).toBe(25);
    for (const t of [comp, ind]) expect(t.reduce((s, o) => s + o.p, 0)).toBeCloseTo(1, 12);
  });

  it("independent win probability is 0.5 + edgeA - edgeB, exact to 2dp, and averages to your own edge", () => {
    expect(winProbabilityA({ A: 0.7, B: 0.3 }, "independent")).toBe(0.9);
    expect(winProbabilityA({ A: 0.3, B: 0.7 }, "independent")).toBe(0.1);
    expect(winProbabilityA({ A: 0.4, B: 0.4 }, "independent")).toBe(0.5);
    expect(winProbabilityA({ A: 0.6, B: 0.3 }, "independent")).toBe(0.8);
    for (const a of EDGES) {
      const avg = EDGES.reduce((s, b) => s + winProbabilityA({ A: a, B: b }, "independent"), 0) / EDGES.length;
      expect(avg).toBeCloseTo(a, 12);
    }
  });

  describe("independent deal in the simulator", () => {
    const LOGS: MatchLog[] = [];
    const master = mulberry32(2718);
    for (const turnOrder of ["simultaneous", "alternating"] as TurnOrder[]) {
      for (let k = 0; k < 4_000; k++) {
        const pool = agentPool(nextUint32(master));
        LOGS.push(
          playMatch(pool[k % pool.length]!, pool[(k >> 3) % pool.length]!, { seed: nextUint32(master), turnOrder, ...independent }),
        );
      }
    }
    const rounds = LOGS.flatMap((l) => l.rounds);

    it("draws both edges independently and uniformly", () => {
      const counts = new Map<string, number>();
      for (const r of rounds) {
        expect(EDGES).toContain(r.edges.A);
        expect(EDGES).toContain(r.edges.B);
        const k = `${r.edges.A},${r.edges.B}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      expect(counts.size).toBe(25);
      for (const n of counts.values()) expect(Math.abs(n / rounds.length - 1 / 25)).toBeLessThan(0.006);
    });

    it("flips with the deal's probability, and win rates match it", () => {
      const byP = new Map<number, { a: number; n: number }>();
      for (const r of rounds) {
        if (r.flip === null) continue;
        const p = winProbabilityA(r.edges, "independent");
        expect(r.flip.probabilityAWins).toBe(p);
        expect(r.flip.winner).toBe(r.flip.roll < p ? "A" : "B");
        const w = byP.get(p) ?? { a: 0, n: 0 };
        w.n++;
        if (r.winner === "A") w.a++;
        byP.set(p, w);
      }
      for (const [p, { a, n }] of byP) if (n > 500) expect(Math.abs(a / n - p)).toBeLessThan(0.05);
    });

    it("stays zero-sum, bounded and deterministic", () => {
      for (const log of LOGS) {
        expect(log.nets.A + log.nets.B).toBe(0);
        expect(log.rounds.length).toBeLessThanOrEqual(3);
      }
      for (let seed = 0; seed < 100; seed++) {
        const run = () => playMatch(PRESETS.Mirage, PRESETS.Anchor, { seed, turnOrder: "alternating", ...independent });
        expect(run()).toEqual(run());
      }
    });
  });

  it("an agent's view does not change with the opponent's edge", () => {
    const stakes = freezeStakes(CLASSIC_STAKES);
    for (const leader of [null, "A", "B"] as const) {
      const seenByB: View[][] = [];
      for (const edgeA of EDGES) {
        const views: View[] = [];
        const spyB: Agent = (v) => {
          views.push(v);
          return "call";
        };
        decideRound(constantAgent("call"), spyB, initialState(leader), { A: edgeA, B: 0.4 }, stakes);
        seenByB.push(views);
      }
      for (const views of seenByB) expect(views).toEqual(seenByB[0]);
    }
  });

  it("exact calculator agrees with simulation under the independent deal", () => {
    const agents: Agent[] = [...PRESET_NAMES.map((n) => PRESETS[n]), constantAgent("raise")];
    const master = mulberry32(1618);
    const N = 20_000;
    for (const turnOrder of ["simultaneous", "alternating"] as TurnOrder[]) {
      for (const [i, a] of agents.entries()) {
        const b = agents[(i + 1) % agents.length]!;
        let sum = 0;
        let sq = 0;
        for (let k = 0; k < N; k++) {
          const net = playMatch(a, b, { seed: nextUint32(master), turnOrder, ...independent }).nets.A;
          sum += net;
          sq += net * net;
        }
        const mean = sum / N;
        const se = Math.sqrt((sq / N - mean * mean) / N);
        expect(Math.abs(mean - expectedNet(a, b, { turnOrder, ...independent }))).toBeLessThan(4 * se);
      }
    }
  });

  it("mirror matches are exactly even under the fair leader coin", () => {
    for (const n of PRESET_NAMES) {
      expect(expectedNet(PRESETS[n], PRESETS[n], { turnOrder: "alternating", ...independent })).toBeCloseTo(0, 12);
      expect(expectedNet(PRESETS[n], PRESETS[n], independent)).toBeCloseTo(0, 12);
    }
  });
});
