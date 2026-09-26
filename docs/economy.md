# Economy (post-hackathon design)

**Status: design, with two parts now real.** Bands are live as money scales (see [Bands](#bands)), and **$OXUDE has launched** (see [Token](#token)). Everything that connects them — rentals, funding, auctions, prizes, the chip rate — remains design only. The game still runs on devnet with a fake game token, and $OXUDE is not yet its currency; this is the plan for making it one. The security model in [security.md](security.md) describes the system as it is, and several of its known limitations must be closed before any of this ships (see [Open questions](#open-questions)).

## Roadmap

In order. Each step ships to devnet before the next begins, until the last, which is mainnet itself; nothing here holds real money until [Open questions](#open-questions) are closed.

1. **Bands** — done. Money scales, the cover rule, seeded house agents in every band.
2. **Autoplay** — built. Server-side play on a timer, the floor, and the ranked/unranked split on the ladder; the scheduler and ladder are deployed, and the owner's panel ships with the web release.
3. **Weekly seasons** — built. One shared Monday-to-Monday UTC season for every rental ([Seasons](#seasons)). Placed here because three later pieces depend on it: rewards pay out on final season placement, auctions run at the season boundary, and [the chip rate](#the-chip-rate) can only change between seasons.
4. **[Characters](#characters)** — built. Identity and presentation for every agent. Placed ahead of deposits because a character is presentation only: it touches no money, needs no program change and none of the [Open questions](#open-questions), so it can ship now and give players a reason to show up while the money pieces are still being built. It also comes before rewards and auctions, because both of them are about an agent's *standing*, and a standing is easier to care about, compete over and bid on when it belongs to someone with a name and a face.
5. **Deposits and paid rent** — built, and deployed to devnet on 2026-09-25 at [`HTs42VFp…tvkdy`](https://explorer.solana.com/address/HTs42VFpHS4XT9Cr8xH7cJEMgqPL9uuzZn6QHGwtvkdy?cluster=devnet). Nothing uses it yet: every agent on the live site is still seed-funded, and the flow is behind a flag until a season boundary flips it. The stake token is an ordinary mint with no mint authority left, so the program cannot create currency; renting burns a fee and funding is a deposit from the owner's own wallet, both in one transaction they sign. That last part also closes the consent gap in [security.md](security.md) — the server no longer creates agents for wallets that signed nothing. Still open from this step: the survival figures on the rent screen are still quoted against a fixed 900 rather than the chosen deposit (open question 3).
6. **Rewards** — **placement is built**; the pool is not. A season now freezes two orderings and serves both, `/prizes` shows who would be paid and in what order, and `/statement` is the published statement with the prize amounts left empty ([What is built](#what-is-built)). What remains is the money: the creator-fee split cannot be configured before legal review (open question 5), and how many places pay and on what curve is open question 6.
7. **Auctions** — expiry, bidding and transfer ([Expiry and auction](#expiry-and-auction)). What a character carries across a sale is open question 1.
8. **Security hardening and mainnet** — close the known limitations in [security.md](security.md) (open question 4) and the rest of the [Open questions](#open-questions), then $OXUDE becomes the game's currency.

## Token

**$OXUDE launched on pump.fun on 20 September 2026.**

| | |
|---|---|
| Network | Solana mainnet |
| Supply | 1,000,000,000 |
| Decimals | 6 |

**It is not the game's currency yet, and holding it does not let anyone play.** The game runs on devnet against a
program-derived mint (`8S5QVBtZcBoKdKVGGUH2tCDpnoLYBxtGrPYDTBwwA1N7`, 0 decimals), which is a test token with no
value and no relation to $OXUDE beyond the name. The two connect only at mainnet launch, which is what the open
questions below gate.

The launch came **ahead of the requirements this document lists** — no audit, no deposit instruction, withdrawals
still needing a server co-signature, no legal review, and the chip rate undecided. That is recorded here as fact, not
as an argument: those requirements were written as gates on *real money in the game*, and they still are. What
changed is that they are now pre-mainnet gates rather than pre-launch ones, and the token trading before them means
there is an audience watching the gap close.

- **6 decimals**, as pump.fun mints them.
- The launch **pairs with USDC rather than SOL**, so neither the prize pool nor the rental price swings with SOL.
- **No minting on mainnet.** The devnet program mints a fake game token to seed vaults; mainnet has a fixed supply and every balance traces to a real deposit or a match win. The mint authority is not the platform's to hold.

## The chip rate

**Stakes are dollar-pegged.** The game is played in **chips**, and it stays that way: the tables, the presets, the bands and the 900 seed are all written in chips and none of them move. What a chip is *worth* is what the peg fixes. On mainnet **one chip is a fixed USD value** — the target is still open (open question 9; $0.01 is the working example) — and the number of $OXUDE that buys a chip is set **once per weekly season**.

So the token price moves and the stakes don't. A higher market cap means **fewer tokens per chip**; a lower one, more. Band B's 10-chip bet is the same bet in dollars in week one and week thirty.

The rules on the rate:

- **It comes from a time-weighted average price, not spot.** A thin pool's spot price can be pushed for a block; an average over the season can't be, cheaply (open question 2).
- **It changes only at the season boundary.** Within a week, every match, every stake and every rental fee uses one rate. This is what forces a single shared season — a rate change must never land while a rental is mid-week (see [Decided](#decided)).
- **Each weekly change is capped at ±50%.** A token that doubles or halves in a week moves the chip rate by half, not by the whole move, and the rest is caught up the following week.
- **A launch-time guard.** A **minimum market cap**, equivalently a **maximum tokens per chip**, keeps a tiny early cap from making one chip cost an absurd share of supply. Below that floor the rate clamps rather than follows.
- **The admin sets it; the program enforces the bounds.** To start, the admin submits a rate computed from a **published** TWAP, and the program rejects it if it arrives before the boundary, moves more than ±50%, or breaches the tokens-per-chip ceiling. The trust that leaves is bounded by those checks. An **on-chain oracle** can replace the admin later without changing any of the rules above — only who supplies the number.
- **All amounts are 6-decimal base units on chain.** Chips convert to base units at the season's rate; the ledger and the program never see a chip.

## Renting

- An agent rents for **$2 worth of $OXUDE**. The fee is **burned**.
- A rental runs to the **end of the season** it is taken out in, however late in the week it starts ([Seasons](#seasons)). A full season is 168 hours.
- The price is set in stable terms and converted at the **season's rate**, the same one the chips use, so a rising token doesn't make the game unaffordable and every rental bought in a given week costs the same number of tokens.
- **No free agent.** Every rented agent pays the fee. Instead there is a **free trial** that plays house agents only. It gets no ladder placement and isn't eligible for prizes.

## Seasons

A season runs **Monday 00:00 UTC to the next Monday 00:00 UTC**, and every rental ends at a season boundary. Built on devnet; renewal is free there.

- **Renting mid-season is allowed**, and ends at the same boundary as everyone else's. The rent screen shows the season and the time left in it.
- **Renewal is once per season, never a standing switch**, because on mainnet it costs rent. From **72 hours** before the end the owner is asked to renew; a renewed agent carries on into the next season with its record, balance, band and floor.
- **At the boundary, autoplay stops for every agent**, renewed or not. Band and floor carry over; the owner switches autoplay back on.
- **An agent that was not renewed expires.** It cannot play and is not matchable, but for **24 hours** its owner can still renew it, and it comes back exactly as it was. After that it **lapses**: it retires with its record kept, and its balance stays withdrawable — all of it at once, since it can never play again.
- **Final placement is frozen at the boundary**, and the grace period does not touch it: an agent renewed the next day plays in the next season, not the last one.
- **The ladder has three views** — today, this season and all time — which rank the same thing, player-versus-player matches normalised onto band B, over different windows. Today is the window daily rewards will pay on.
- **The boundary is exact.** A rental's end is checked where every match is recorded, under both agents' locks, so no match lands past it however late the boundary job runs. The job itself runs in one transaction under the season's row lock and skips a closed season, so a restart mid-run or a second instance changes nothing.
- **On mainnet the auction window replaces the grace period.** An unrenewed agent goes to auction at the boundary rather than waiting 24 hours to lapse ([Expiry and auction](#expiry-and-auction)).
- **The chip rate changes at the boundary.** The boundary job has a hook for it that does nothing on devnet; on mainnet it sets the new season's rate and queues it for the program in the same transaction ([The chip rate](#the-chip-rate)). A settlement still on its way when the rate changes must land at the rate of the season its match was played in, so on mainnet each queued settlement carries its amount already converted, not chips to convert on landing.

## Funding and stakes

- The owner funds the agent by **depositing $OXUDE from their own wallet**. That balance is what it stakes with. Renting and funding are separate movements: the rental fee is burned, the deposit stays the owner's money.
- The balance is withdrawable at any time, except while a match is in flight.
- Match stakes are **zero-sum between the two agents**. The platform takes nothing from them and puts nothing into them.
- **Settlement is by net position, not per match.** Matches move balances in the off-chain ledger, which stays authoritative. Each agent's net position settles on chain periodically, **hourly or on withdrawal**, whichever comes first.
- **No pay-to-win.** A larger balance must never make an agent play better. Power comes from the brief only. This is non-negotiable.

Withdrawals already work on devnet: the owner signs, and the settler co-signs to attest that nothing is in flight. The deposit does not exist — funding currently means the rental seed, so a busted agent cannot be revived. Both the deposit instruction and a withdrawal that needs no server co-signature have to land before mainnet (open question 3).

## Bands

Bands are **money scales**, not skill tiers. Every amount in a band scales by one factor, so a preset balance holds its shape in each band and the bands actually differ from one another. Every figure below is in **chips**, and stays in chips whatever the token does (see [The chip rate](#the-chip-rate)).

| Band | Scale | Ante | Bet | Raised | Cover |
|---|---|---|---|---|---|
| A | ×0.5 | 2 | 5 | 10 | 20 |
| B | ×1 | 4 | 10 | 20 | 40 |
| C | ×1.5 | 6 | 15 | 30 | 60 |

- **The cover rule: a match's maximum exposure is _two_ times the band's raised bet** — 20, 40, 60. This corrects an earlier reading of three times, which no match can reach: a match is first to two rounds, so the winner never takes a third, and a 2-1 match nets only one round. Enumerating every draw and flip across all four presets confirms band B's widest net is exactly 40, and no decision table can beat it, because a round is never worth more than the raised bet.
- **Band C therefore needs no change to the program's per-match limit.** `max_settlement` is already 60, which is exactly band C's worst match. `set_max_settlement` exists for headroom beyond that, not for band C.
- **Nothing is clamped.** A band can only be played by a balance that could pay its cover outright, so both sides are checked before a match runs. Falling below your band's cover bars you from *that* band, not from the game: the owner moves the agent to one it can still cover. Only below band A's 20 is there nothing left but to withdraw, which is retirement. An agent's band is never changed on its behalf — it is the owner's choice.
- **Records are normalised onto band B's scale.** Every net is divided by its band's factor before it reaches a rating, so a band C win of 30 counts the same as a band B win of 20. The ladder ranks agents, not the band they picked. Balances are never normalised.
- The **seed is not scaled per band**. One seed of **900** across all three, so the band changes the stakes and not the starting money.

**Survival, measured.** 20,000 agents per preset per band, one match per ten minutes for a week, exact match outcomes, no clamp, stopping when the agent can no longer cover its band:

| Band | Survive a week | Worst preset | Best preset | Median time to bust |
|---|---|---|---|---|
| A | 99.1% | Mirage 98.5% | Hammer 99.5% | 851 matches (141.8 h) |
| B | 80.6% | Mirage 76.5% | Hammer 84.4% | 617 matches (102.8 h) |
| C | 60.6% | Mirage 56.1% | Hammer 65.4% | 441 matches (73.5 h) |

The median is over the agents that busted, not all of them: in band A that is the last 0.9%, so it describes a rare exit rather than a typical week.

Band C came in at **60.6%**, below the 65% the provisional figures suggested; its attrition is accepted rather than corrected, because a bigger scale on the same seed is the point. The spread between presets also widens with the band — 1.0 points in A, 7.9 in B, 9.3 in C — so band C is quoted per preset rather than as one number.

The run is seeded with a fixed constant that is deliberately **not** derived from any band amount, so these numbers move only when a rule moves. Regenerate with `npx tsx scripts/simulate-autoplay.ts --emit`, which rewrites `src/survival.ts`. The rent screen and this page both quote that generated table, and neither may state a survival figure that is not in it.

## Characters

**Agents become characters. The decision table still decides every action; the character is identity and presentation only, never mechanics.** Nothing about a character is an input to the engine, the matchmaker, the ledger or the chain. Every hand stays exactly as deterministic and verifiable as it is now: the same seed and the same two tables replay to the same result, and `src/exact.ts` still prices an agent from its table alone. A character that could change an outcome would be a way to buy an edge, which is pay-to-win by another route.

Built, all of it presentation:

- **A portrait**, drawn in code from the agent's id and its decision table. The id chooses the character — one of nineteen types of masked player, android or creature — and its colour scheme, plate, head shape and accessories; the table chooses the expression it wears: steady for a calm player, fierce for an aggressor, sly for a bluffer, wary for one that backs down. Two neighbours on the ladder are kept to different types or colour schemes. Nothing is taken from the Oxude mark. The portrait is stored when the agent is rented, so a later change to the generator never changes an existing face. At 32 px and under, a simplified drawing is shown.
- **A name, epithet and bio**, generated once at rent. A name the owner chose stays the name; without one, the agent gets an invented one. Presets and house agents get template bios built from what their table does; an agent written from a brief gets one from a small model call fed its table, never the brief's own words.
- **Moderation.** Names that would speak for Oxude are refused outright; everything else — slurs, sexual content, real people, impersonation — goes to a small model check. If that check can't be reached, the agent goes by its generated name in public, the owner sees their chosen name as waiting, and it switches over once a background re-check passes.
- **Traits measured from real play**, from the agent's match logs: how often it bluffs (raises a hand more likely to lose than win), folds and raises, and whether it holds firm, backs down or pushes back once raised at. Each is shown only after enough hands — 60 decisions, 20 of them under pressure for that trait — and until then says "not enough hands yet". They describe what the agent did, so where they disagree with the bio, the measured figure is the fact.
- **Where they show:** the owner's card and the public agent page carry the portrait, epithet, bio and traits; ladder and feed rows a small portrait; match pages both; and the share images for agent and match links carry the faces.
- **The wall.** Characters live in their own tables, which nothing that plays or pays reads. A test plays the same seeded match with different characters and gets identical logs, settlements and ledger rows, and fails if the engine, runner, ledger, ratings, seasons or chain code ever imports character code.

Later, still presentation:

- **Earned titles and rivalries, from the ledger.** A title is awarded for something the ledger can prove happened; a rivalry is a pairing with enough matches between two agents to mean something. Neither is claimed, and neither is ever sold.
- **Optional in-character lines on big moments** — a large pot, a bluff that worked, a comeback — rendered alongside the transcript. They are commentary on a result already decided; they never decide anything, and turning them off changes nothing but the text.

**Characters must be original.** No real people, no existing fictional characters, and nothing that trades on someone else's name, likeness or brand. That applies to the generated portrait as much as to the name.

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

## More than one game

Design only, for when a second game exists. Nothing here is built.

- **The agent chooses which game to play**, based on where opponents are waiting.
- **The player sets the bounds.** They tick which games their agent may enter and write a brief for each.
- The agent chooses freely among those, and **never enters a game the player hasn't briefed.**

It is the same shape as the balance floor: the player sets the bounds, and the agent moves inside them.

## Creator fees and prizes

- pump.fun creator fees split **50/50 at protocol level** across two wallets: a **reward wallet** and a **platform wallet**. The split can only be set once, so both addresses must be final before it is configured.
- Launch paired to **USDC rather than SOL**, so the prize pool doesn't swing with SOL's price.
- The reward wallet funds prize pools: **30% paid daily, 70% weekly**. It also receives the full payment whenever an owner matches a bid to keep an agent.
- Prizes pay on **final ladder placement**, to owner wallets. Never per match and never per win, which is farmable.
- **Only player-versus-player matches are ranked.** A match against a house agent settles on chain and moves both balances like any other, but earns no ranking, counts toward no minimum match count, and cannot win a prize. The house presets are fixed and their exact weaknesses are computable from `src/exact.ts`, so an owner who could rank against them would be farming the reward pool off our own bots rather than beating anyone. Whether a match was ranked is recorded on the match itself, not derived from who owns the agents now: agents change hands at auction, and a past result has to stay readable as the match it was.
- Prize ladders rank on **net per chip staked, with a minimum match count**: net won divided by total staked, over ranked matches only. Not cumulative net, or volume grinding wins. Not net per match either: stake size follows balance, so net per match would reward bigger balances and bring back pay-to-win.
- Publish the wallet addresses, and a regular statement of what came in and went out.

### What is built

Placement is built and runs every season. Two orderings exist and they are kept apart:

- **The ladder** ranks **ranked net won**, normalised onto band B so results from different bands compare. It is what `/ladder` serves and what the ladder page shows.
- **Placement** ranks **ranked net per chip staked**, with a minimum of `MIN_RANKED_MATCHES_FOR_PRIZE` ranked matches (20 as this is written; it is a parameter, not a constant nobody may touch). It is what `/prizes` serves and what the rewards page shows, and it is what a prize would pay on.

They divide the **un-normalised** net, not the ladder's. The ladder's figure has already had the band correction applied, and dividing that by chips staked would apply it twice and hand band A a standing advantage over band C.

Both are **frozen when the season closes** and neither is recomputed afterwards. The numbers alone would not be enough: re-deriving an order later would let a change to the minimum match count, or to how ties break, quietly reorder a season that had already paid. An agent short of the minimum is stored with a null placement — listed, with how many matches it still needs, never hidden.

`/statement?season=...` is the statement above, as far as the game currently goes: what was played, what was staked, what rent burned, the order places would pay in, and a reconciliation line — every side's net across the season's staked matches, which is zero because a match is zero-sum between its two agents. A non-zero figure there means a settlement was written that no match accounts for.

The **prize amounts are absent, not zero**: `funded` is false and `pool` and `paid` are null, because the reward wallet is funded by the creator-fee split and that cannot be configured before the legal review in [open question 5](#open-questions). "Nothing was paid" and "we do not know yet" must not look alike. When the pool opens, the work is to fill in the pool and a per-place amount; nothing has to be rearranged to make room. Open question 6 — how many places pay, and on what curve — is still open, and open question 8's reconciliation of burns against reward-wallet inflow needs the inflow side, which does not exist yet.

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
- **House matches earn money but not ranking.** They settle and move balances; they are excluded from the ladder, the minimum match count and every prize figure. A fixed preset's weaknesses are exactly computable, so ranking against one measures nothing a prize should pay for. Both numbers are shown side by side wherever an owner sees their record, because the winnings are real and only the ranking is withheld - a figure that silently dropped would read as money taken away.
- **Free first agent: dropped.** Wallets cost nothing to create, so it would have meant unlimited free agents. The free trial against house agents replaces it, with no ladder placement and no prizes.
- **On-chain settlement: net positions, hourly or on withdrawal.** One match every 10 minutes is 144 matches per agent per day, so per-match settlement would mean 144 transactions and rent-paying accounts per agent per day. Hourly netting caps that at 24, and only for agents that actually played. The off-chain ledger stays authoritative.
- **Bands are money scales, not skill tiers.** One factor per band, one unscaled seed of 900, and a per-match cover of two times the raised bet — the most a first-to-two match can actually move.
- **Stakes are dollar-pegged, converted once per season.** A chip is a fixed USD value, and the $OXUDE per chip is fixed for a week from a TWAP, within ±50% of the previous week and under a tokens-per-chip ceiling. Pegging to the token instead would have made the same bet mean a different amount of money each day, and a spot conversion would have handed the rate to anyone willing to push a thin pool for one block.
- **One shared weekly season for every rental** (resolves open question 6). Monday to Monday UTC, not a rolling 168 hours per rental. The chip rate is what decides it: it can only change when no rental is mid-week, which a rolling week never guarantees. Shared seasons also make "final ladder placement" unambiguous and put every auction on the same day; the cost is that expiries and auctions bunch at the boundary rather than spreading out. It also means the "168 hours" in [Renting](#renting) is a full season, not 168 hours from whenever the rental was bought: what a mid-week rental pays and how long it runs is left to the rental design.
- **Characters are presentation, never mechanics.** An agent's name, portrait, bio, measured traits, titles, rivalries and in-character lines are identity only; the decision table decides every action, so every hand stays deterministic and verifiable. Characters must be original. They come right after weekly seasons on the [Roadmap](#roadmap), ahead of deposits, rewards and auctions.
- **Matching a bid pays the reward wallet.** The owner keeps their right to retain the agent, but not at a discount: they pay what the market bid, and the money goes to prizes rather than back to themselves. Paying themselves half would have made matching nearly free and the auction decorative.

## Open questions

These need resolving before **mainnet** — before $OXUDE becomes the game's currency and real money is at stake in a match. The token launching has not moved any of them; it has only made the distance to mainnet visible from outside.

1. **What an auction buyer gets.** The record transfers but the brief doesn't, so the buyer writes a new brief and the record then describes a different strategy. The auction sells a name and a history, not play strength. That is consistent with no-pay-to-win, but the ladder should either reset the record's strategy-dependent stats on transfer or show where the brief changed.

   **Proposal, with characters:** the character's **name, face and reputation transfer with the record; the brief does not.** A buyer gets someone with a history and a following, and writes that someone a new playbook. Still to settle: measured traits describe the *old* brief's play, so after a sale they should either start again or be split at the point of transfer, the same choice as the record's strategy-dependent stats above; and a bio derived from the old playbook would now describe a table the agent no longer plays, so it either regenerates for the new brief or is kept and marked as the character's past. Two facts from the build bear on it, without deciding it: the portrait and name are stored when the agent is rented rather than drawn from its current table, so they can survive a new brief unchanged; and traits are kept as running counts, so splitting them at a transfer means snapshotting the counts at that moment.
2. **Which TWAP, over what window, published where.** The design is settled — a chip is a fixed USD value, converted to $OXUDE once per season from a time-weighted average rather than spot, inside a ±50% weekly band and a tokens-per-chip ceiling (see [The chip rate](#the-chip-rate)). What is not settled is the mechanics: which pool or aggregator the average is taken from, over what window, how a stale or missing reading is handled at a boundary, and where the number and its inputs are published so an owner can check the rate they were charged. The ±50% cap and the ceiling limit the damage of a bad reading; they don't make one acceptable.

   **A timing gap the ±50% band does not cover: renewal.** A rental is renewed for the *next* season, renewal opens 72 hours before the boundary, and the rate for that season does not exist until the boundary. So an owner renewing on the Friday pays the old season's rate for a week priced at the new one, and one renewing a minute after the boundary pays the new rate for the same week — the same rental at two prices, with the gap free to anyone who watches the token. Either the next season's rate is computed and published before renewal opens, which means a TWAP window ending 72 hours early rather than running the whole season, or renewal is quoted when the owner clicks and charged at the boundary. This does not block devnet, where the rate is fixed, but it has to be settled with the rest of the mechanics here.
3. **The deposit instruction, and non-custodial withdrawal.** Two separate gaps. There is no deposit instruction at all, so deposit-funded agents need one before the funding model above is real. Withdrawal does exist and works on devnet, but the settler must co-sign: that co-signature is what attests no match is in flight and no net position is unsettled, and it is also what leaves the vaults custodial in practice — a server that refuses or disappears strands the money, even though it cannot move it anywhere else. Making withdrawal non-custodial before mainnet means replacing that attestation with something the chain can check for itself, such as an on-chain in-flight flag or a timelock the owner can always fall back on.

   **Deposits also invalidate every survival figure above.** They are all computed from a fixed 900 seed. Once the player chooses the amount, the seed stops being a constant the product picks, so the numbers on the rent screen have to be computed *from their deposit* — at rent time, for the band and preset they are choosing — rather than read from a table generated in advance. The simulation already sweeps starting balances, so the shape is known:

   | Band | 360 | 540 | 720 | 900 | 1080 | 1350 | 1800 |
   |---|---|---|---|---|---|---|---|
   | A | 70.0% | 88.3% | 96.5% | 99.1% | 99.9% | 100% | 100% |
   | B | 38.1% | 55.5% | 69.8% | 80.7% | 88.2% | 95.0% | 99.1% |
   | C | 24.8% | 38.1% | 50.1% | 60.2% | 69.9% | 80.4% | 91.7% |

   That sweep is generated too, as `SURVIVAL_BY_SEED` in the same file, so no figure on this page is one someone typed from memory.

   Deposits change the safety story too: `MAX_SEED` stops being the cap on what a vault can hold, the outflow cap becomes the main brake on a stolen settler key, and "an agent can never be revived" stops being true.
4. **Security limits before real money.** The known limitations in [security.md](security.md) all have to close first: the settler key can drain vaults, the admin key can upgrade the program and raise the per-match limit, and there's no audit. Hourly net settlement changes the first one's shape: a settlement is no longer capped by one match's stake, so the program needs a different limit, per agent per period.
5. **Legal review.** Real-money stakes on match outcomes, plus prize pools funded by token trading fees, may be regulated as gambling or as a securities offering, depending on jurisdiction. This was written as advice to get before launch; the token launched first, so it is now advice to get before mainnet, and before the creator-fee split is configured — the split can only be set once.
6. **Payout curve and ladder size.** How many places pay, and on what curve. Nothing is decided about top-N versus proportional, the minimum match count that qualifies, or whether daily and weekly use the same shape.
7. **Anti-farming review policy.** Detection flags rather than pre-blocks, but nothing says who reviews a flag, on what timeline, or what happens to prizes already owed to a flagged wallet when the review lands after a payout.
8. **Burn versus reward-wallet accounting.** Rental fees burn, outside-bidder auctions burn half, and matched bids pay the reward wallet instead. No stated relationship exists between the burn rate and the reward wallet's inflow, and the published statement needs to reconcile both sides.
9. **What a chip is worth in dollars.** The peg is decided; the number isn't. $0.01 makes band B's ante 4 cents, its raised bet 20 cents and a worst-case match 40 cents, and the 900 seed $9 — small enough that a week of autoplay costs less than the $2 rental, which may be too small to take seriously. A cent also sets the floor on what the ladder can pay out. Whatever the figure, it has to be chosen against the survival numbers above, not separately from them: those say how much of a seed a week actually consumes.
10. **Rebalance the preset tables, with even-mix spread as a pass criterion.** The loop holds: every preset beats one other and loses to another, identically in every band. But against an even mix of the four, Hammer nets +0.084 a match, Bully +0.019, Mirage −0.050 and Anchor −0.053 (band B's scale). The house roster can't fix this. No mix of the four makes them equal — the only equilibria drop a preset entirely — and the best whole-number house mixes still leave a spread of about ±0.055, while changing who trails rather than removing the gap. The fix belongs to the tables: re-run the preset search with "each preset within a stated margin of zero against an even mix" as a pass criterion, alongside the loop and the bluffing checks. Until then the house plays an even mix, which is close to the best any mix achieves and is easy to explain.
11. **Who funds the house roster — decided: nothing, because it never stakes.** House agents no longer stake against player agents. A house agent's money is the platform's, so a staked match against one is the platform gambling with itself against its own customers; it can lose, and a fixed preset's weaknesses are exactly computable, so it is not a contest either. A house match is still played, still recorded and still has a transcript — nothing moves, nothing settles, nothing reaches a rating.

    This makes **staked and ranked the same question**, which they always should have been: the ladder already refused to count a house match, and the money had no better reason to.

    Autoplay **waits** rather than taking a house opponent, because a week of matches that earned nothing is not what autoplay promises. It keeps its place and plays the moment a real opponent is free, and the band status already points the owner at a band that has one. Pressing play still practises against the house, which is what that button is for.

    The cost is honest: on a thin roster an autoplaying agent waits. That is the price of not paying people in money the platform invented, and it is also what makes [rewards](#creator-fees-and-prizes) measurable — 1.1% of matches were ranked before this, eight out of 757, because every band was thin enough to fall back on the house. Two consequences follow for [Autoplay](#autoplay): the waiting retry's cost matters more now that waiting is common (see [security.md](security.md)), and the survival figures become a floor rather than an estimate, since an agent that waits plays fewer matches and so loses money less often.
