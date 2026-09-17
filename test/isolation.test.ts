import { describe, expect, it } from "vitest";
import { CLASSIC_STAKES, exactView, mulberry32, nextUint32, playMatch, PRESETS, type Agent, type View } from "../src/index.js";
import { randomAgent } from "./helpers.js";

const VIEW_KEYS = ["myActionThisRound", "myEdge", "myNet", "myRoundsWon", "oppActionThisRound", "oppRaiseCount", "oppRaisedLastRound", "oppRoundsWon", "roundNumber", "stakes"];

describe("agent isolation", () => {
  it("views contain exactly the allowed keys, with the agent's own edge only", () => {
    const master = mulberry32(2024);
    for (let k = 0; k < 2_000; k++) {
      const seen: { A: View[]; B: View[] } = { A: [], B: [] };
      const record =
        (seat: "A" | "B", inner: Agent): Agent =>
        (view) => {
          seen[seat].push(view);
          return inner(view);
        };
      const log = playMatch(record("A", randomAgent(nextUint32(master))), record("B", PRESETS.Bully), {
        seed: nextUint32(master),
      });

      log.rounds.forEach((r, i) => {
        const va = seen.A[i]!;
        const vb = seen.B[i]!;
        for (const v of [va, vb]) {
          // Catches oppEdge / edges / opponent-related keys, including non-enumerable or symbol ones.
          expect(Reflect.ownKeys(v).map(String).sort()).toEqual(VIEW_KEYS);
          expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
          expect(Object.isFrozen(v)).toBe(true);
          expect(Object.isFrozen(v.stakes)).toBe(true);
          expect(v.stakes).toEqual(log.stakes);
          expect(Reflect.ownKeys(v.stakes).map(String).sort()).toEqual(["ante", "baseBet", "raisedBet"]);
        }
        expect(va.myEdge).toBe(r.edges.A);
        expect(vb.myEdge).toBe(r.edges.B);
      });
    }
  });

  it("an agent's decisions cannot depend on the opponent's edge", () => {
    // Same seed => same edges for A. Swapping B's strategy changes nothing A can observe
    // in round 1, so A's first view must be identical.
    const firstView = (opp: Agent) => {
      let captured: View | undefined;
      const spy: Agent = (v) => {
        captured ??= v;
        return "call";
      };
      playMatch(spy, opp, { seed: 555 });
      return captured;
    };
    expect(firstView(PRESETS.Mirage)).toEqual(firstView(PRESETS.Anchor));
  });

  it("agents cannot mutate the view they are given, including its stakes", () => {
    const vandal: Agent = (v) => {
      expect(() => {
        (v as { myNet: number }).myNet = 1_000;
      }).toThrow(TypeError);
      expect(() => {
        (v.stakes as { ante: number }).ante = 0;
      }).toThrow(TypeError);
      return "call";
    };
    const log = playMatch(vandal, PRESETS.Hammer, { seed: 9 });
    expect(log.nets.A + log.nets.B).toBe(0);
  });

  it("exactView rejects extra keys at compile time", () => {
    const base = { myEdge: 0.3, myRoundsWon: 0, oppRoundsWon: 0, roundNumber: 1, oppRaiseCount: 0, oppRaisedLastRound: false, myNet: 0, stakes: CLASSIC_STAKES, oppActionThisRound: null, myActionThisRound: null };
    // @ts-expect-error -- oppEdge is not part of View
    exactView({ ...base, oppEdge: 0.7 });
    // @ts-expect-error -- View has no opponent-edge field to read
    ((v: View) => v.oppEdge)(exactView(base));
    expect(exactView(base)).toBe(base);
  });
});
