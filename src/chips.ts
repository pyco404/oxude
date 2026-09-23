/**
 * Chips and base units.
 *
 * The game is played in **chips**: the bands, the presets, the tables, the
 * ratings and every number on the screen are chips, and none of them move when
 * the token does. What a chip is *worth* is the season's rate.
 *
 * Everything that holds money holds **base units** of the stake token - the
 * ledger, the vaults, the settlement program. **No chip balance is ever
 * stored.** An agent's chips are computed from its base units when they are
 * needed, and that is what makes a rate change safe: at a season boundary the
 * same tokens simply count as a different number of chips, so there is no
 * conversion event to stand in front of. The design that stores chips and
 * converts them to tokens is the one you can farm - deposit while chips are
 * cheap in tokens, withdraw while they are dear - and this is not it.
 *
 * The rate is a property of the flow an agent was rented under, because the two
 * flows use different tokens:
 *
 *   seed     the frozen program's mint: 0 decimals, and one token was one chip.
 *            Rate 1, for ever - that program is frozen and its rate cannot move.
 *   deposit  the stake token: 6 decimals. One chip is one whole token on
 *            devnet; on mainnet the season boundary sets it.
 *
 * Because the seed flow's rate is 1, every ledger row written before any of
 * this is already a correct base-unit value, and widening the columns needed no
 * backfill.
 */

import { DEVNET_CHIP_RATE } from "./chain/settlement.js";

/** Which funding flow an agent was rented under, which decides its stake token. */
export type Funding = "seed" | "deposit";

/**
 * The seed flow's rate. One, and not a coincidence worth relying on elsewhere:
 * that program's mint has 0 decimals and was minted a token per chip.
 */
export const SEED_CHIP_RATE = 1;

/** Base units in one chip for an agent on this flow, at this season's rate. */
export function chipRate(funding: Funding, seasonRate: number = DEVNET_CHIP_RATE): number {
  return funding === "seed" ? SEED_CHIP_RATE : seasonRate;
}

/**
 * An amount of chips in base units. Exact: chips are whole and so is the rate,
 * so a match's net converts without any rounding at all. Both agents in a match
 * are on the same rate, so a settlement stays zero-sum in base units too.
 */
export function baseUnits(chips: number, rate: number): number {
  return chips * rate;
}

/**
 * Base units as chips, rounding towards zero.
 *
 * Rounding appears only here, in the view. Amounts that began as chips - a
 * stake, a match's net - are exact multiples of the rate and come back
 * unchanged. What can have a remainder is a balance, because a deposit or a
 * withdrawal is any number of base units the owner chose, and that remainder is
 * dust: less than a chip, and nothing can be staked with it. Rounding it down
 * is the conservative direction, which is the one to take with somebody's
 * money.
 */
export function chips(amount: number, rate: number): number {
  return Math.trunc(amount / rate);
}
