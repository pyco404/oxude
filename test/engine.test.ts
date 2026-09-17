import { describe, expect, it } from "vitest";
import {
  ANTE,
  BASE_BET,
  EDGES,
  MAX_ROUNDS,
  RAISED_BET,
  ROUNDS_TO_WIN,
  CLASSIC_RULES,
  mulberry32,
  nextUint32,
  FLIP_FOR_ANTE_RULES,
  RAISE_AT_RISK_RULES,
  type MatchRules,
  playMatch,
  PRESETS,
  type MatchLog,
} from "../src/index.js";
import { agentPool, constantAgent, randomAgent } from "./helpers.js";

/** Plays many matches across every pairing in the pool (fresh random agents each time). */
function manyMatches(count: number, masterSeed: number, rules: MatchRules = CLASSIC_RULES): MatchLog[] {
  const master = mulberry32(masterSeed);
  const logs: MatchLog[] = [];
  for (let k = 0; k < count; k++) {
    const pool = agentPool(nextUint32(master));
    const a = pool[k % pool.length]!;
    const b = pool[Math.floor(k / pool.length) % pool.length]!;
    logs.push(playMatch(a, b, { seed: nextUint32(master), rules }));
  }
  return logs;
}

const LOGS = manyMatches(10_000, 12345);
const RISK_LOGS = manyMatches(10_000, 54321, RAISE_AT_RISK_RULES);
const ANTE_FLIP_LOGS = manyMatches(10_000, 777, FLIP_FOR_ANTE_RULES);
const ALL_LOGS = [...LOGS, ...RISK_LOGS, ...ANTE_FLIP_LOGS];

describe("zero-sum", () => {
  it("nets sum to zero at the end of every match and after every round", () => {
    for (const log of ALL_LOGS) {
      expect(log.nets.A + log.nets.B).toBe(0);
      for (const r of log.rounds) expect(r.nets.A + r.nets.B).toBe(0);
    }
  });

  it("final nets equal the last round's running nets and the sum of transfers", () => {
    for (const log of ALL_LOGS) {
      const last = log.rounds[log.rounds.length - 1]!;
      expect(log.nets).toEqual(last.nets);
      const sumA = log.rounds.reduce((s, r) => s + (r.winner === "A" ? r.bet : r.winner === "B" ? -r.bet : 0), 0);
      expect(log.nets.A).toBe(sumA);
    }
  });
});

describe("match length", () => {
  it("never exceeds 3 rounds and ends as soon as someone has 2 round wins", () => {
    for (const log of ALL_LOGS) {
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
      const a = playMatch(PRESETS.Tricky, randomAgent(seed * 7), { seed });
      const b = playMatch(PRESETS.Tricky, randomAgent(seed * 7), { seed });
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
      const log = playMatch(PRESETS.Steady, PRESETS.Patient, { seed });
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
    for (const log of ALL_LOGS) {
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
    for (const log of ALL_LOGS) {
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

  it("rejects invalid actions from an agent", () => {
    const bad = (() => "allin") as unknown as () => "call";
    expect(() => playMatch(bad, constantAgent("call"), { seed: 1 })).toThrow(/invalid action/);
  });
});

describe("fold-to-raise rules", () => {
  it("defaults to classic rules and records the rules in the log", () => {
    expect(playMatch(constantAgent("raise"), constantAgent("fold"), { seed: 1 }).rules).toEqual(CLASSIC_RULES);
    expect(
      playMatch(constantAgent("raise"), constantAgent("fold"), { seed: 1, rules: RAISE_AT_RISK_RULES }).rules,
    ).toEqual(RAISE_AT_RISK_RULES);
  });

  it("classic rules: folding to a raise pays the ante with no flip", () => {
    const r = playMatch(constantAgent("raise"), constantAgent("fold"), { seed: 1 }).rounds[0]!;
    expect(r.outcome).toBe("one-folded");
    expect(r.flip).toBeNull();
    expect(r.winner).toBe("A");
    expect(r.bet).toBe(ANTE);
  });

  it("folding to a raise still flips: raiser wins the ante or loses the raised bet", () => {
    const seen = { raiserWon: 0, raiserLost: 0 };
    for (let seed = 0; seed < 400; seed++) {
      for (const raiserSeat of ["A", "B"] as const) {
        const [a, b] = raiserSeat === "A" ? (["raise", "fold"] as const) : (["fold", "raise"] as const);
        const log = playMatch(constantAgent(a), constantAgent(b), { seed, rules: RAISE_AT_RISK_RULES });
        let expectedA = 0;
        for (const r of log.rounds) {
          expect(r.outcome).toBe("folded-to-raise");
          expect(r.flip).not.toBeNull();
          expect(r.flip!.winner).toBe(r.flip!.roll < r.edges.A ? "A" : "B");
          expect(r.winner).toBe(r.flip!.winner);
          const raiserWon = r.winner === raiserSeat;
          expect(r.bet).toBe(raiserWon ? ANTE : RAISED_BET);
          seen[raiserWon ? "raiserWon" : "raiserLost"]++;
          expectedA += r.winner === "A" ? r.bet : -r.bet;
          expect(r.nets.A).toBe(expectedA);
        }
      }
    }
    expect(seen.raiserWon).toBeGreaterThan(0);
    expect(seen.raiserLost).toBeGreaterThan(0);
  });

  it("flip-for-ante: folding to a raise flips for the ante only", () => {
    const seen = { A: 0, B: 0 };
    for (let seed = 0; seed < 400; seed++) {
      for (const [a, b] of [["raise", "fold"], ["fold", "raise"]] as const) {
        const log = playMatch(constantAgent(a), constantAgent(b), { seed, rules: FLIP_FOR_ANTE_RULES });
        let expectedA = 0;
        for (const r of log.rounds) {
          expect(r.outcome).toBe("folded-to-raise");
          expect(r.flip).not.toBeNull();
          expect(r.flip!.winner).toBe(r.flip!.roll < r.edges.A ? "A" : "B");
          expect(r.winner).toBe(r.flip!.winner);
          expect(r.bet).toBe(ANTE);
          seen[r.winner!]++;
          expectedA += r.winner === "A" ? ANTE : -ANTE;
          expect(r.nets.A).toBe(expectedA);
        }
      }
    }
    expect(seen.A).toBeGreaterThan(0);
    expect(seen.B).toBeGreaterThan(0);
  });

  it.each([
    ["raiser-risks-raise", () => RISK_LOGS],
    ["flip-for-ante", () => ANTE_FLIP_LOGS],
  ] as const)("%s: only fold-versus-raise changes; every other round resolves as in classic rules", (_, logs) => {
    const ruleLogs = logs();
    for (const log of ruleLogs) {
      for (const r of log.rounds) {
        const { A, B } = r.actions;
        const foldVsRaise = (A === "fold" && B === "raise") || (A === "raise" && B === "fold");
        if (foldVsRaise) {
          expect(r.outcome).toBe("folded-to-raise");
        } else if (A === "fold" && B === "fold") {
          expect(r.outcome).toBe("both-folded");
        } else if (A === "fold" || B === "fold") {
          expect(r.outcome).toBe("one-folded");
          expect(r.bet).toBe(ANTE);
          expect(r.flip).toBeNull();
          expect(r.winner).toBe(A === "fold" ? "B" : "A");
        } else {
          expect(r.outcome).toBe("flipped");
          expect(r.bet).toBe(A === "raise" || B === "raise" ? RAISED_BET : BASE_BET);
        }
      }
    }
    expect(ruleLogs.some((l) => l.rounds.some((r) => r.outcome === "folded-to-raise"))).toBe(true);
  });

  it("is deterministic per seed under every ruleset", () => {
    for (const rules of [CLASSIC_RULES, RAISE_AT_RISK_RULES, FLIP_FOR_ANTE_RULES]) {
      for (let seed = 0; seed < 200; seed++) {
        const run = () => playMatch(PRESETS.Tricky, PRESETS.Reckless, { seed, rules });
        expect(run()).toEqual(run());
      }
    }
  });

  it("does not alias the caller's rules object", () => {
    const rules: MatchRules = { foldToRaise: "raiser-risks-raise" };
    const log = playMatch(constantAgent("raise"), constantAgent("fold"), { seed: 1, rules });
    rules.foldToRaise = "classic";
    expect(log.rules.foldToRaise).toBe("raiser-risks-raise");
  });
});

describe("log", () => {
  it("round-trips through JSON unchanged", () => {
    for (const log of [...LOGS.slice(0, 200), ...RISK_LOGS.slice(0, 200), ...ANTE_FLIP_LOGS.slice(0, 200)]) {
      expect(JSON.parse(JSON.stringify(log))).toEqual(log);
    }
  });

  it("round snapshots are not aliased to live engine state", () => {
    const log = playMatch(PRESETS.Reckless, PRESETS.Steady, { seed: 77 });
    const nets = log.rounds.map((r) => ({ ...r.nets }));
    expect(log.rounds.map((r) => r.nets)).toEqual(nets);
    expect(log.rounds[0]!.nets).not.toBe(log.nets);
  });
});
