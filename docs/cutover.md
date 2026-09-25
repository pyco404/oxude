# The seed flow cutover

Oxude has two settlement programs on devnet. This is the plan for closing the
older one, and it is short because the machinery already existed: **every rental
ends at a season boundary**, so a rental that cannot be renewed simply runs out.

| | |
|---|---|
| Old, closing | [`EKJHJ8js…n8kir`](https://explorer.solana.com/address/EKJHJ8jsuXQ9hzy4qPXMsAHDagA38C1pkDWoz3un8kir?cluster=devnet) — seeds a free balance, mints its own token |
| New | [`HTs42VFp…tvkdy`](https://explorer.solana.com/address/HTs42VFpHS4XT9Cr8xH7cJEMgqPL9uuzZn6QHGwtvkdy?cluster=devnet) — owner funds the agent, fixed-supply token |

## Why now, and not later

The old program's settler key was exposed on 2026-09-25, and **it cannot be
rotated**: the deployed bytecode has no `set_settler` (see
[security.md](security.md)). Whoever holds that key can mint about 18,000 chips
per ten-minute window into vaults of their own, and drain any existing vault at
roughly a fifth of its balance per window. On devnet that is worth nothing, but
a drained vault stops matching the ledger, and **a withdrawal checks exactly
that** — so the practical harm is that owners find their balances stuck.

The exposure lasts exactly as long as the last un-retired seed agent. That is
the argument for closing quickly rather than tidily.

## The dates

| When | What |
|---|---|
| Now | `SEED_CUTOVER=closed` — no new seed rentals, no seed renewals |
| **2026-09-28 00:00 UTC** | The season boundary. Seed agents stop playing and expire |
| **2026-09-29 00:00 UTC** | Grace ends. They lapse; record kept, balance still withdrawable |

Nothing new enforces the first date: a rental already ends there, and refusing
the renewal is the whole of the change.

## What is not being done, and why

**Balances are not migrated.** Every seed chip was minted free by the program,
so there is nothing of value to move, and each way of moving it is worse than
leaving it. Withdrawing on owners' behalf needs each owner's signature, which
cannot be collected. Upgrading the old program to rotate its settler would ship
every other change since its deploy — including a different withdrawal rule —
to the program holding every live vault. And waiting for the balances to be
withdrawn one by one just extends the window in which they can be drained.

Owners re-rent on the new program and fund the agent themselves. On devnet the
faucet supplies the tokens, so this costs them nothing but a signature.

## Watching it

Three alarms now cover the window, all of which were absent when the key was
exposed:

- **vaults short of the ledger** — the shape a drain takes, and nothing looked
  before;
- **settlement lag** — the outbox standing still;
- **settler SOL** — the account that pays for everything running dry.

A surplus in a *seed* vault is never credited, because the exposed key can mint
and the money may be invented. Only the deposit program's surpluses are counted,
where the token has no mint authority.
