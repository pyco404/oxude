import { describe, expect, it } from "vitest";
import {
  ANTE,
  BASE_BET,
  expectedNet,
  mulberry32,
  nextUint32,
  playMatch,
  PRESET_NAMES,
  PRESETS,
  RAISED_BET,
  seatAveragedNet,
  type Action,
  type Agent,
  type MatchLog,
  type View,
} from "../src/index.js";
import { agentPool, constantAgent } from "./helpers.js";

const turn = { turnOrder: "alternating" } as const;

/** Agent scripted by situation: what to do when leading, responding to a call/raise, and answering a raise. */
function scripted(lead: Action, vsCall: Action, vsRaise: Action, answer: Action = "call"): Agent {
  return (v) => {
    if (v.myActionThisRound !== null) return answer;
    if (v.oppActionThisRound === "raise") return vsRaise;
    if (v.oppActionThisRound === "call") return vsCall;
    return lead;
  };
}

/** Plays round 1 with A leading (finds a seed where the coin gives A the lead). */
function roundOneWithALeading(a: Agent, b: Agent) {
  for (let seed = 0; ; seed++) {
    const log = playMatch(a, b, { seed, ...turn });
    if (log.firstLeader === "A") return log.rounds[0]!;
  }
}

describe("alternating turn order", () => {
  const LOGS: MatchLog[] = [];
  const master = mulberry32(99);
  for (let k = 0; k < 5_000; k++) {
    const pool = agentPool(nextUint32(master));
    const a = pool[k % pool.length]!;
    const b = pool[Math.floor(k / pool.length) % pool.length]!;
    LOGS.push(playMatch(a, b, { seed: nextUint32(master), ...turn }));
  }

  it("records the turn order, and leadership alternates from a fair coin", () => {
    let aFirst = 0;
    for (const log of LOGS) {
      expect(log.turnOrder).toBe("alternating");
      expect(log.firstLeader).not.toBeNull();
      if (log.firstLeader === "A") aFirst++;
      log.rounds.forEach((r, i) => {
        expect(r.leader).toBe(i % 2 === 0 ? log.firstLeader : log.firstLeader === "A" ? "B" : "A");
        expect(r.sequence[0]!.seat).toBe(r.leader);
      });
    }
    expect(Math.abs(aFirst / LOGS.length - 0.5)).toBeLessThan(0.03);
  });

  it("keeps zero-sum, match length and resolution invariants", () => {
    for (const log of LOGS) {
      expect(log.nets.A + log.nets.B).toBe(0);
      expect(log.rounds.length).toBeLessThanOrEqual(3);
      for (const r of log.rounds) {
        expect(r.outcome).not.toBe("both-folded");
        expect(r.sequence.length).toBeGreaterThanOrEqual(1);
        expect(r.sequence.length).toBeLessThanOrEqual(3);
        if (r.outcome === "flipped") {
          expect(r.bet).toBe(r.actions.A === "raise" || r.actions.B === "raise" ? RAISED_BET : BASE_BET);
        }
        // At most one raise per round.
        expect(r.sequence.filter((s) => s.action === "raise").length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic per seed and round-trips through JSON", () => {
    for (let seed = 0; seed < 200; seed++) {
      const run = () => playMatch(PRESETS.Tricky, PRESETS.Steady, { seed, ...turn });
      expect(run()).toEqual(run());
      expect(JSON.parse(JSON.stringify(run()))).toEqual(run());
    }
  });

  it("leader fold ends the round: responder never acts and wins the ante", () => {
    let respondedToFold = false;
    const responder: Agent = (v) => {
      if (v.oppActionThisRound === "fold") respondedToFold = true;
      return "call";
    };
    const r = roundOneWithALeading(constantAgent("fold"), responder);
    expect(r.sequence).toEqual([{ seat: "A", action: "fold" }]);
    expect(r.outcome).toBe("one-folded");
    expect(r.winner).toBe("B");
    expect(r.bet).toBe(ANTE);
    expect(respondedToFold).toBe(false);
  });

  it("the responder can fold to a raise in the same round", () => {
    const r = roundOneWithALeading(scripted("raise", "call", "call"), scripted("call", "call", "fold"));
    expect(r.sequence).toEqual([
      { seat: "A", action: "raise" },
      { seat: "B", action: "fold" },
    ]);
    expect(r.outcome).toBe("one-folded");
    expect(r.winner).toBe("A");
    expect(r.bet).toBe(ANTE);
  });

  it("a re-raise counts as a call", () => {
    const r = roundOneWithALeading(scripted("raise", "call", "call"), scripted("raise", "raise", "raise"));
    expect(r.sequence).toEqual([
      { seat: "A", action: "raise" },
      { seat: "B", action: "call" },
    ]);
    expect(r.outcome).toBe("flipped");
    expect(r.bet).toBe(RAISED_BET);
  });

  it("call then call flips for the base bet", () => {
    const r = roundOneWithALeading(scripted("call", "call", "call"), scripted("call", "call", "call"));
    expect(r.sequence.map((s) => s.action)).toEqual(["call", "call"]);
    expect(r.bet).toBe(BASE_BET);
  });

  it("call then raise gives the leader a fold-or-call answer", () => {
    const answers: View[] = [];
    const leader: Agent = (v) => {
      if (v.myActionThisRound !== null) answers.push(v);
      return v.myActionThisRound !== null ? "fold" : "call";
    };
    const r = roundOneWithALeading(leader, scripted("raise", "raise", "call"));
    expect(r.sequence).toEqual([
      { seat: "A", action: "call" },
      { seat: "B", action: "raise" },
      { seat: "A", action: "fold" },
    ]);
    expect(r.winner).toBe("B");
    expect(r.bet).toBe(ANTE);
    expect(answers[0]!.myActionThisRound).toBe("call");
    expect(answers[0]!.oppActionThisRound).toBe("raise");

    const called = roundOneWithALeading(scripted("call", "call", "call", "raise"), scripted("raise", "raise", "call"));
    expect(called.sequence.map((s) => s.action)).toEqual(["call", "raise", "call"]);
    expect(called.outcome).toBe("flipped");
    expect(called.bet).toBe(RAISED_BET);
  });

  it("views show only what the opponent has already done this round", () => {
    const seen: View[] = [];
    const spy: Agent = (v) => {
      seen.push(v);
      return "call";
    };
    roundOneWithALeading(spy, constantAgent("call"));
    expect(seen[0]!.oppActionThisRound).toBeNull();
    const seenB: View[] = [];
    roundOneWithALeading(constantAgent("raise"), (v) => {
      seenB.push(v);
      return "call";
    });
    expect(seenB[0]!.oppActionThisRound).toBe("raise");
    expect(seenB[0]!.myActionThisRound).toBeNull();
  });

  it("simultaneous play is still the default", () => {
    const log = playMatch(PRESETS.Steady, PRESETS.Tricky, { seed: 5 });
    expect(log.turnOrder).toBe("simultaneous");
    expect(log.firstLeader).toBeNull();
    expect(log.rounds.every((r) => r.leader === null && r.sequence.length === 2)).toBe(true);
  });
});

describe("exact calculator with alternating turns", () => {
  it("agrees with simulation within sampling error", () => {
    const agents: Agent[] = [...PRESET_NAMES.map((n) => PRESETS[n]), constantAgent("raise")];
    const master = mulberry32(4242);
    const N = 20_000;
    for (const [i, a] of agents.entries()) {
      const b = agents[(i + 2) % agents.length]!;
      let sum = 0;
      let sq = 0;
      for (let k = 0; k < N; k++) {
        const net = playMatch(a, b, { seed: nextUint32(master), ...turn }).nets.A;
        sum += net;
        sq += net * net;
      }
      const mean = sum / N;
      const se = Math.sqrt((sq / N - mean * mean) / N);
      expect(Math.abs(mean - expectedNet(a, b, turn))).toBeLessThan(4 * se);
    }
  });

  it("the fair coin removes any seat advantage in mirror matches", () => {
    for (const name of PRESET_NAMES) expect(expectedNet(PRESETS[name], PRESETS[name], turn)).toBeCloseTo(0, 12);
  });

  it("averages the two fixed-leader values", () => {
    const [a, b] = [PRESETS.Steady, PRESETS.Patient];
    const fixedA = expectedNet(a, b, { ...turn, firstLeader: "A" });
    const fixedB = expectedNet(a, b, { ...turn, firstLeader: "B" });
    expect(expectedNet(a, b, turn)).toBeCloseTo((fixedA + fixedB) / 2, 12);
    expect(seatAveragedNet(a, b, turn)).toBeCloseTo(-seatAveragedNet(b, a, turn), 12);
  });
});
