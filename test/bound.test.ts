import { describe, expect, it } from "vitest";
import { maxNet, mulberry32, nextUint32, playMatch, type Stakes } from "../src/index.js";
import { assertNetWithinBound } from "../src/db/runner.js";
import { StakeError } from "../src/db/ledger.js";
import { bandStakes, STAKE_BANDS } from "../src/db/schema.js";
import { agentPool } from "./helpers.js";

/**
 * The money code checks a vault covers a band's `worstMatch` before a match is
 * played. That number is only safe if the engine really cannot move more, so
 * these tests hold the two against each other from both ends: the bound the
 * engine declares must equal the one the band table promises, and no match the
 * engine actually plays may exceed it.
 */
describe("the engine's bound", () => {
  it("is what every band's worstMatch claims it is", () => {
    for (const band of STAKE_BANDS) {
      expect(maxNet(bandStakes(band.name))).toBe(band.worstMatch);
    }
  });

  it("is not exceeded by any match, at any band, over many seeds", () => {
    const master = mulberry32(98765);
    for (const band of STAKE_BANDS) {
      const stakes = bandStakes(band.name);
      const bound = maxNet(stakes);
      for (let k = 0; k < 2000; k++) {
        const pool = agentPool(nextUint32(master));
        const a = pool[k % pool.length]!;
        const b = pool[Math.floor(k / pool.length) % pool.length]!;
        const log = playMatch(a, b, { stakes, seed: nextUint32(master) });
        expect(Math.abs(log.nets.A)).toBeLessThanOrEqual(bound);
        expect(log.nets.A + log.nets.B).toBe(0);
      }
    }
  });

  it("grows with the largest of the three stakes, not the raise alone", () => {
    // A rules set whose ante is the biggest number in it is not one we ship,
    // but the bound has to hold for whatever the engine is handed.
    const odd: Stakes = { ante: 50, baseBet: 5, raisedBet: 10 };
    expect(maxNet(odd)).toBe(100);
  });
});

describe("the runner's enforcement", () => {
  const stakes = bandStakes("B"); // bound 40

  it("passes a net the engine could have produced", () => {
    expect(() => assertNetWithinBound(40, stakes, "a match")).not.toThrow();
    expect(() => assertNetWithinBound(-40, stakes, "a match")).not.toThrow();
    expect(() => assertNetWithinBound(0, stakes, "a match")).not.toThrow();
  });

  it("throws on a net over the bound, in either direction", () => {
    expect(() => assertNetWithinBound(41, stakes, "a match")).toThrow(StakeError);
    expect(() => assertNetWithinBound(-41, stakes, "a match")).toThrow(StakeError);
  });

  it("says what disagreed, so the failure is diagnosable", () => {
    try {
      assertNetWithinBound(999, stakes, "Bully against Anchor");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(String(e)).toContain("Bully against Anchor");
      expect(String(e)).toContain("999");
      expect(String(e)).toContain("at most 40");
      expect(String(e)).toContain("nothing was recorded");
    }
  });
});
