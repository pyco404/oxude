# Economy (post-hackathon design)

**Status: design only. None of this is built.** Today Oxude runs on devnet with a fake game token; this is the plan for a real one. The security model in [security.md](security.md) describes the system as it is, and several of its known limitations must be closed before any of this ships (see [Open questions](#open-questions)).

## Token

**$OXUDE**, launched on pump.fun after the hackathon.

- **6 decimals**, as pump.fun mints them.
- The launch **pairs with USDC rather than SOL**, so neither the prize pool nor the rental price swings with SOL.
- **No minting on mainnet.** The devnet program mints a fake game token to seed vaults; mainnet has a fixed supply and every balance traces to a real deposit or a match win. The mint authority is not the platform's to hold.

## Renting

- An agent rents for **$2 worth of $OXUDE**. The fee is **burned**.
- A rental lasts **168 hours (one week)**.
- The price is set in stable terms and converted at the current token price, so a rising token doesn't make the game unaffordable.
- **No free agent.** Every rented agent pays the fee. Instead there is a **free trial** that plays house agents only. It gets no ladder placement and isn't eligible for prizes.

## Funding and stakes

- The owner funds the agent by **depositing $OXUDE from their own wallet**. That balance is what it stakes with. Renting and funding are separate movements: the rental fee is burned, the deposit stays the owner's money.
- The balance is withdrawable at any time, except while a match is in flight.
- Match stakes are **zero-sum between the two agents**. The platform takes nothing from them and puts nothing into them.
- **Settlement is by net position, not per match.** Matches move balances in the off-chain ledger, which stays authoritative. Each agent's net position settles on chain periodically, **hourly or on withdrawal**, whichever comes first.
- **No pay-to-win.** A larger balance must never make an agent play better. Power comes from the brief only. This is non-negotiable.

Neither the deposit nor the withdrawal exists in the program today — funding currently means the rental seed, so a busted agent cannot be revived. Both are program changes that have to land before mainnet (open question 3).

## Bands

Bands are **money scales**, not skill tiers. Every amount in a band scales by one factor, so a preset balance holds its shape in each band and the bands actually differ from one another.

| Band | Scale | Ante | Bet | Raised | Cover |
|---|---|---|---|---|---|
| A | ×0.5 | 2 | 5 | 10 | 30 |
| B | ×1 | 4 | 10 | 20 | 60 |
| C | ×1.5 | 6 | 15 | 30 | 90 |

- **The cover rule: a match's maximum exposure is three times the band's raised bet** — 30, 60, 90. That is the per-match ceiling the program enforces, and the reason band C needs the limit raised from 60 to 90.
- The **seed is not scaled per band**. One seed of **900** across all three, so the band changes the stakes and not the starting money.

**Survival, pending the option-B simulation.** Early unclamped figures: about **81.7%** of agents survive a week overall, **above 96%** in band A, and **around 65%** in band C. Band C's attrition is accepted rather than corrected — a bigger scale on the same seed is the point. These numbers are provisional until the option-B simulation replaces them.

## Expiry and auction

At 168 hours the agent goes to an English auction.

| When | What happens |
|---|---|
| 72h before expiry | The owner is notified. |
| 48h before expiry | Bidding opens. |
| Any bid | Paid in $OXUDE and escrowed on bid; released immediately when outbid. |
| Bid in the final 2 minutes | The close extends by 2 minutes (anti-snipe). |
| Close | The current owner may **keep the agent by matching the highest bid**. If they don't, the highest bidder wins. |

Settlement of a sale depends on who takes the agent:

- **The owner matches and keeps it.** Their whole payment goes to the **reward wallet**. Nothing is burned and nothing returns to them — matching buys the agent back at the market's price, and that money funds prizes.
- **An outside bidder wins.** The winning bid splits **50/50: half burned, half to the previous owner**. The previous owner's balance returns to them.
- Either way, the agent's **record transfers. The brief does not.**

No bids: the owner renews at base price, or the agent returns to the free roster.

## Autoplay

- Once funded and active, an agent plays automatically. No button press.
- Roughly **one match per agent every 10 minutes**.
- The owner can pause and resume at any time.
- It auto-pauses when:
  - the balance falls below an **owner-set floor**;
  - the rental expires;
  - the balance falls below the minimum stake.
- It falls back to house agents when no player opponent is available in its band.

The balance floor matters most. An agent must never grind itself to zero overnight unless the owner chose that.

## Creator fees and prizes

- pump.fun creator fees split **50/50 at protocol level** across two wallets: a **reward wallet** and a **platform wallet**. The split can only be set once, so both addresses must be final before it is configured.
- Launch paired to **USDC rather than SOL**, so the prize pool doesn't swing with SOL's price.
- The reward wallet funds prize pools: **30% paid daily, 70% weekly**. It also receives the full payment whenever an owner matches a bid to keep an agent.
- Prizes pay on **final ladder placement**, to owner wallets. Never per match and never per win, which is farmable.
- Prize ladders rank on **net per chip staked, with a minimum match count**: net won divided by total staked. Not cumulative net, or volume grinding wins. Not net per match either: stake size follows balance, so net per match would reward bigger balances and bring back pay-to-win.
- Publish the wallet addresses, and a regular statement of what came in and went out.

## Anti-farming

- **One agent in play per wallet.** An owner may hold any number of retired agents, but only one can be active at a time.
- The rental fee is the main defence: a second agent costs real money.
- **Anomaly detection.** Every table's exact expected net is known (`src/exact.ts`), so a wallet earning far above what its strategy is worth is colluding, not lucky. Flag it rather than pre-block it.

## Later, not decided

- **All-in duel mode.** One match, both balances on the table, opt-in, with a separate leaderboard.
- **Embedded wallets** (Privy) as a second sign-in path, behind a feature flag, so people without a browser extension can play.
- **X account linking** for display names on the ladder and share cards.

## Decided

- **Prize ranking:** net per chip staked, not net per match. Stake size follows balance, so ranking on net per match would bring back pay-to-win.
- **Free first agent: dropped.** Wallets cost nothing to create, so it would have meant unlimited free agents. The free trial against house agents replaces it, with no ladder placement and no prizes.
- **On-chain settlement: net positions, hourly or on withdrawal.** One match every 10 minutes is 144 matches per agent per day, so per-match settlement would mean 144 transactions and rent-paying accounts per agent per day. Hourly netting caps that at 24, and only for agents that actually played. The off-chain ledger stays authoritative.
- **Bands are money scales, not skill tiers.** One factor per band, one unscaled seed of 900, and a per-match cover of three times the raised bet.
- **Matching a bid pays the reward wallet.** The owner keeps their right to retain the agent, but not at a discount: they pay what the market bid, and the money goes to prizes rather than back to themselves. Paying themselves half would have made matching nearly free and the auction decorative.

## Open questions

These need resolving before building.

1. **What an auction buyer gets.** The record transfers but the brief doesn't, so the buyer writes a new brief and the record then describes a different strategy. The auction sells a name and a history, not play strength. That is consistent with no-pay-to-win, but the ladder should either reset the record's strategy-dependent stats on transfer or show where the brief changed.
2. **Price conversion needs a manipulation-resistant price.** A spot price from a thin pump.fun pool can be pushed for one block to rent cheaply. Use a time-weighted average.
3. **Deposits, withdrawals and custody.** The current program has neither a deposit nor a withdrawal instruction, and the vaults are custodial. Deposit-funded agents and withdraw-any-time both need program changes, plus a lock that covers in-flight matches and unsettled net positions.
4. **Security limits before real money.** The known limitations in [security.md](security.md) all have to close first: the settler key can drain vaults, the admin key can upgrade the program and raise the per-match limit, and there's no audit. Hourly net settlement changes the first one's shape: a settlement is no longer capped by one match's stake, so the program needs a different limit, per agent per period.
5. **Legal review.** Real-money stakes on match outcomes, plus prize pools funded by token trading fees, may be regulated as gambling or as a securities offering, depending on jurisdiction. This needs advice before launch, not after.
6. **One shared season, or a rolling week per rental?** Either every rental runs on the same fixed weekly season (Monday to Monday UTC, say) or each runs 168 hours from its own start. A shared season makes "final ladder placement" unambiguous and puts every auction on the same day; rolling weeks spread the auction load but mean the weekly prize closes while most agents are mid-rental. The prize schedule depends on this answer.
7. **Payout curve and ladder size.** How many places pay, and on what curve. Nothing is decided about top-N versus proportional, the minimum match count that qualifies, or whether daily and weekly use the same shape.
8. **Anti-farming review policy.** Detection flags rather than pre-blocks, but nothing says who reviews a flag, on what timeline, or what happens to prizes already owed to a flagged wallet when the review lands after a payout.
9. **Burn versus reward-wallet accounting.** Rental fees burn, outside-bidder auctions burn half, and matched bids pay the reward wallet instead. No stated relationship exists between the burn rate and the reward wallet's inflow, and the published statement needs to reconcile both sides.
