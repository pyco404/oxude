import { describe, expect, it } from "vitest";
import {
  ANTE,
  BASE_BET,
  EDGES,
  MAX_ROUNDS,
  RAISED_BET,
  ROUNDS_TO_WIN,
  mulberry32,
  nextUint32,
  playMatch,
  PRESETS,
  type MatchLog,
} from "../src/index.js";
import { agentPool, constantAgent, randomAgent } from "./helpers.js";

/** Plays many matches across every pairing in the pool (fresh random agents each time). */
function manyMatches(count: number, masterSeed: number): MatchLog[] {
  const master = mulberry32(masterSeed);
  const logs: MatchLog[] = [];
  for (let k = 0; k < count; k++) {
    const pool = agentPool(nextUint32(master));
    const a = pool[k % pool.length]!;
    const b = pool[Math.floor(k / pool.length) % pool.length]!;
    logs.push(playMatch(a, b, { seed: nextUint32(master) }));
  }
  return logs;
}

const LOGS = manyMatches(10_000, 12345);

describe("zero-sum", () => {
  it("nets sum to zero at the end of every match and after every round", () => {
    for (const log of LOGS) {
      expect(log.nets.A + log.nets.B).toBe(0);
      for (const r of log.rounds) expect(r.nets.A + r.nets.B).toBe(0);
    }
  });

  it("final nets equal the last round's running nets and the sum of transfers", () => {
    for (const log of LOGS) {
      const last = log.rounds[log.rounds.length - 1]!;
      expect(log.nets).toEqual(last.nets);
      const sumA = log.rounds.reduce((s, r) => s + (r.winner === "A" ? r.bet : r.winner === "B" ? -r.bet : 0), 0);
      expect(log.nets.A).toBe(sumA);
    }
  });
});

describe("match length", () => {
  it("never exceeds 3 rounds and ends as soon as someone has 2 round wins", () => {
    for (const log of LOGS) {
      expect(log.rounds.length).toBeGreaterThanOrEqual(1);
      expect(log.rounds.length).toBeLessThanOrEqual(MAX_ROUNDS);
      log.rounds.forEach((r, i) => {
        expect(r.roundNumber).toBe(i + 1);
        const reached = r.roundsWon.A >= ROUNDS_TO_WIN || r.roundsWon.B >= ROUNDS_TO_WIN;
        // Only the final round may be the one where a player reaches 2 wins.
        if (i < log.rounds.length - 1) expect(reached).toBe(false);
      });
      if (log.rounds.length < MAX_ROUNDS) expect(log.endReason).toBe("round-wins");
      expect(Math.max(log.roundsWon.A, log.roundsWon.B)).toBeLessThanOrEqual(ROUNDS_TO_WIN);
    }
  });

  it("covers early finishes, full-length matches and undecided matches in the sample", () => {
    expect(LOGS.some((l) => l.rounds.length === 2)).toBe(true);
    expect(LOGS.some((l) => l.rounds.length === 3 && l.winner !== null)).toBe(true);
    expect(LOGS.some((l) => l.winner === null)).toBe(true);
  });

  it("a 2-0 sweep ends after round 2", () => {
    const log = playMatch(constantAgent("call"), constantAgent("fold"), { seed: 1 });
    expect(log.rounds).toHaveLength(2);
    expect(log.winner).toBe("A");
    expect(log.nets).toEqual({ A: 2 * ANTE, B: -2 * ANTE });
  });

  it("all-fold matches still stop after 3 rounds", () => {
    const log = playMatch(constantAgent("fold"), constantAgent("fold"), { seed: 1 });
    expect(log.rounds).toHaveLength(MAX_ROUNDS);
    expect(log.winner).toBeNull();
    expect(log.endReason).toBe("max-rounds");
  });
});

describe("determinism", () => {
  it("same seed and agents produce identical logs", () => {
    for (let seed = 0; seed < 500; seed++) {
      const a = playMatch(PRESETS.Bully, randomAgent(seed * 7), { seed });
      const b = playMatch(PRESETS.Bully, randomAgent(seed * 7), { seed });
      expect(b).toEqual(a);
    }
  });

  it("different seeds diverge", () => {
    // Callers always flip, so every log carries continuous rolls that cannot collide by chance.
    const serialised = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const log = playMatch(constantAgent("call"), constantAgent("raise"), { seed });
      serialised.add(JSON.stringify(log.rounds));
    }
    expect(serialised.size).toBe(200);

    // Presets diverge too, in discrete outcomes (edges, actions, winners), not just rolls.
    const outcomes = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const log = playMatch(PRESETS.Hammer, PRESETS.Mirage, { seed });
      outcomes.add(JSON.stringify(log.rounds.map((r) => [r.edges.A, r.actions, r.winner])));
    }
    expect(outcomes.size).toBeGreaterThan(20);
  });

  it("never calls Math.random", () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random used");
    };
    try {
      manyMatches(200, 99);
    } finally {
      Math.random = original;
    }
  });

  it("mulberry32 is reproducible and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(b()).toBe(x);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("round resolution", () => {
  it("edges come from the fixed set and B's edge is exactly the complement literal", () => {
    const seen = new Set<number>();
    for (const log of LOGS) {
      for (const r of log.rounds) {
        expect(EDGES).toContain(r.edges.A);
        expect(EDGES).toContain(r.edges.B);
        expect(r.edges.A + r.edges.B).toBeCloseTo(1, 12);
        seen.add(r.edges.A);
      }
    }
    expect(seen.size).toBe(EDGES.length);
  });

  it("both-fold rounds move no money, flip nothing and award nothing", () => {
    let count = 0;
    for (const log of LOGS) {
      log.rounds.forEach((r, i) => {
        if (r.actions.A !== "fold" || r.actions.B !== "fold") return;
        count++;
        const before = i === 0 ? { A: 0, B: 0 } : log.rounds[i - 1]!.nets;
        const wonBefore = i === 0 ? { A: 0, B: 0 } : log.rounds[i - 1]!.roundsWon;
        expect(r.outcome).toBe("both-folded");
        expect(r.bet).toBe(0);
        expect(r.flip).toBeNull();
        expect(r.winner).toBeNull();
        expect(r.nets).toEqual(before);
        expect(r.roundsWon).toEqual(wonBefore);
      });
    }
    expect(count).toBeGreaterThan(0);
  });

  it("a single fold costs exactly the ante, regardless of raises, and awards the round", () => {
    for (const opp of ["call", "raise"] as const) {
      const log = playMatch(constantAgent("fold"), constantAgent(opp), { seed: 3 });
      const r = log.rounds[0]!;
      expect(r.outcome).toBe("one-folded");
      expect(r.bet).toBe(ANTE);
      expect(r.flip).toBeNull();
      expect(r.winner).toBe("B");
      expect(r.nets).toEqual({ A: -ANTE, B: ANTE });
    }
  });

  it("bet is 20 if either raised, 10 if both called, and the flip uses A's edge", () => {
    for (const log of LOGS) {
      for (const r of log.rounds) {
        if (r.outcome !== "flipped") continue;
        const raised = r.actions.A === "raise" || r.actions.B === "raise";
        expect(r.bet).toBe(raised ? RAISED_BET : BASE_BET);
        expect(r.flip).not.toBeNull();
        expect(r.flip!.probabilityAWins).toBe(r.edges.A);
        expect(r.flip!.winner).toBe(r.flip!.roll < r.edges.A ? "A" : "B");
        expect(r.winner).toBe(r.flip!.winner);
      }
    }
  });

  it("flip win rate matches A's edge", () => {
    const wins = new Map<number, { a: number; n: number }>();
    for (let seed = 0; seed < 20_000; seed++) {
      const r = playMatch(constantAgent("call"), constantAgent("call"), { seed }).rounds[0]!;
      const w = wins.get(r.edges.A) ?? { a: 0, n: 0 };
      w.n++;
      if (r.winner === "A") w.a++;
      wins.set(r.edges.A, w);
    }
    for (const [edge, { a, n }] of wins) expect(Math.abs(a / n - edge)).toBeLessThan(0.03);
  });

  it("raise counts only include completed rounds", () => {
    const views: number[] = [];
    const spy = (v: { oppRaiseCount: number }) => {
      views.push(v.oppRaiseCount);
      return "call" as const;
    };
    // B's view in round n must show the n-1 raises A made in earlier rounds, never the current one.
    const log = playMatch(constantAgent("raise"), spy, { seed: 8 });
    expect(views[0]).toBe(0);
    views.forEach((c, i) => expect(c).toBe(i));
    expect(log.rounds.map((r) => r.raiseCounts.A)).toEqual(views.map((_, i) => i + 1));
  });

  it("oppRaisedLastRound reflects only the immediately previous round", () => {
    // A raises in round 1, calls in round 2, raises in round 3 (if reached).
    const pattern = ["raise", "call", "raise"] as const;
    const a = (v: { roundNumber: number }) => pattern[v.roundNumber - 1]!;
    for (let seed = 0; seed < 300; seed++) {
      const seen: boolean[] = [];
      const b = (v: { oppRaisedLastRound: boolean }) => {
        seen.push(v.oppRaisedLastRound);
        return "call" as const;
      };
      const log = playMatch(a, b, { seed });
      expect(seen).toEqual([false, true, false].slice(0, log.rounds.length));
    }
  });

  it("oppRaisedLastRound is false after a round where the opponent folded", () => {
    const seen: boolean[] = [];
    const a = (v: { roundNumber: number }) => (v.roundNumber === 1 ? "raise" : "fold");
    playMatch(a, (v) => {
      seen.push(v.oppRaisedLastRound);
      return "fold";
    }, { seed: 4 });
    expect(seen).toEqual([false, true, false]);
  });

  it("rejects invalid actions from an agent", () => {
    const bad = (() => "allin") as unknown as () => "call";
    expect(() => playMatch(bad, constantAgent("call"), { seed: 1 })).toThrow(/invalid action/);
  });
});

describe("log", () => {
  it("round-trips through JSON unchanged", () => {
    for (const log of LOGS.slice(0, 500)) {
      expect(JSON.parse(JSON.stringify(log))).toEqual(log);
    }
  });

  it("round snapshots are not aliased to live engine state", () => {
    const log = playMatch(PRESETS.Anchor, PRESETS.Hammer, { seed: 77 });
    const nets = log.rounds.map((r) => ({ ...r.nets }));
    expect(log.rounds.map((r) => r.nets)).toEqual(nets);
    expect(log.rounds[0]!.nets).not.toBe(log.nets);
  });
});
