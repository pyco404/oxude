import { describe, expect, it } from "vitest";
import { connect, migrate } from "../src/db/client.js";
import { balanceOf, record } from "../src/db/ledger.js";
import { createAgent } from "../src/db/runner.js";
import { baseUnits, chipRate, chips, DEVNET_CHIP_RATE, SEED_CHIP_RATE } from "../src/chips.js";
import { STAKE_BANDS } from "../src/db/schema.js";

// Chips against base units: the conversion, and that the ledger is wide enough
// to hold the second of them.

describe("chips and base units", () => {
  it("converts a chip figure exactly, in both directions", () => {
    const rate = DEVNET_CHIP_RATE;
    for (const band of STAKE_BANDS) {
      // A stake begins as chips, so it survives the round trip untouched. This
      // is what keeps a settlement zero-sum in base units as well as in chips.
      expect(chips(baseUnits(band.worstMatch, rate), rate)).toBe(band.worstMatch);
      expect(baseUnits(band.ante, rate)).toBe(band.ante * 1_000_000);
    }
    expect(baseUnits(900, rate)).toBe(900_000_000);
  });

  it("rounds a remainder down, because dust cannot be staked", () => {
    const rate = DEVNET_CHIP_RATE;
    // A deposit or a withdrawal is any number of base units the owner chose, so
    // a balance can sit between two chips. The part of a chip is not spendable.
    expect(chips(900_000_000 + 1, rate)).toBe(900);
    expect(chips(900_999_999, rate)).toBe(900);
    expect(chips(999_999, rate)).toBe(0);
    // Towards zero on both sides, so a loss is never rounded into a bigger one.
    expect(chips(-1_500_000, rate)).toBe(-1);
  });

  it("gives the frozen seed flow a rate of one, and the deposit flow the season's", () => {
    // The seed program's mint has no decimals and was minted a token per chip,
    // and that program is frozen, so its rate can never move.
    expect(chipRate("seed")).toBe(SEED_CHIP_RATE);
    expect(chipRate("seed", DEVNET_CHIP_RATE)).toBe(1);
    expect(chipRate("deposit")).toBe(DEVNET_CHIP_RATE);
    expect(chipRate("deposit", 500_000)).toBe(500_000);
  });

  it("holds a six-decimal balance in the ledger, which a 32-bit column could not", async () => {
    const { db } = await connect();
    await migrate(db);
    const agent = await createAgent(db, { name: "Wide", presetName: "Anchor" });

    // 2,147 chips is where a 32-bit column runs out at six decimals; this is
    // well past it, and is an ordinary balance for a funded agent.
    const big = baseUnits(50_000, DEVNET_CHIP_RATE);
    expect(big).toBeGreaterThan(2_147_483_647);
    await record(db, [{ agentId: agent.id, amount: big, reason: "adjustment" }]);
    expect(await balanceOf(db, agent.id)).toBe(big + 900);

    // And the whole devnet supply, which is the most any one vault could hold.
    const supply = baseUnits(1_000_000_000, DEVNET_CHIP_RATE);
    expect(Number.isSafeInteger(supply)).toBe(true);
    await record(db, [{ agentId: agent.id, amount: supply, reason: "adjustment" }]);
    expect(await balanceOf(db, agent.id)).toBe(big + 900 + supply);
  });
});
