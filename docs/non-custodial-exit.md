# Non-custodial exit

**Status: plan, not built.** Decided 2026-09-26: option B, with today's
co-signed withdrawal kept as the fast path, and a 30-minute window.

A player must be able to get their money out without this server co-signing.
Today they cannot: `withdraw` requires the settler's signature, so a server
that is down, unwilling, or gone is a server that holds the money.

This describes what to build. Nothing here is implemented.

## Why a signature is there at all

A match's outcome exists in the ledger before it exists on chain. In that
window the vault holds money already owed to someone else, and the chain has
no idea. An owner-only withdrawal taken in that window takes the debt with it.

The consequence is **not** a blocked queue. `refusedByProgram` catches
`InsufficientVault` and the worker defers that op and carries on
([worker.ts](../src/chain/worker.ts#L384)), which is deliberate
([worker.ts](../src/chain/worker.ts#L21-L28)). What actually happens is worse,
because it cannot be undone:

- the settlement can never land, and retries forever — `unsendable()` does not
  recognise the case, so the 15-minute lag alarm never clears;
- **the winner is never paid.** The ledger credited them against a vault that
  cannot pay. Ledger total now exceeds chain total.

So the settler signature is load-bearing. It is doing three jobs, and all three
need covering:

1. `has_one = settler` — attests nothing is in flight.
2. It is what makes `remaining` mean anything. The `held - amount == remaining`
   check reads like an independent guard, but the *server* supplies
   `remaining`. An owner choosing both numbers makes it self-consistent and
   vacuous. Removing the signer silently guts it.
3. `payer = settler` — pays the PDA rent and, as fee payer, the transaction
   fee. Players hold no SOL today; this path is the first thing that asks them
   to.

## The mechanism

Two owner-signed instructions with a window between them. No settler signature
on either.

```
request_exit(agent_id, amount)      owner signs
  → Exit PDA { amount, requested_slot, unlock_slot, vault_at_request }
  → server sees it, freezes the agent, settles what it owes

        ... EXIT_WINDOW_SLOTS = 4_500 (~30 minutes) ...

claim_exit(agent_id)                owner signs
  → pays min(amount, vault) to the owner's token account
  → writes claimed_slot, claimed_amount into the same PDA
```

**One Exit PDA per agent**, seeded `[b"exit", agent_id]` — not by a withdrawal
id. This is the single decision the rest of the design rests on: the server can
derive the address of any agent's exit without being told an id, which is what
makes ingestion and reconciliation possible at all. An id chosen by the owner
would be unfindable.

The PDA **is not closed on claim.** It keeps `claimed_slot` and
`claimed_amount` so the server can ingest by reading one deterministic address.
A separate `close_exit` reclaims the rent to the owner, callable once the
server has ingested, or by anyone after a long delay.

Window in slots, not wall clock, to match `WINDOW_SLOTS` and
`MIN_RATE_INTERVAL_SLOTS`. If slots run slow the window is longer than 30
minutes, which is the safe direction: more time to settle, and the player waits.

**The window is configuration, not a constant.** It lives in an `ExitConfig`
singleton, set when an admin turns exits on and moved by `set_exit_window`,
so it can follow the settlement alarm without a program upgrade — and so the
full claim path is testable in seconds rather than twenty minutes.

Its own account rather than a field on `Config`, for a concrete reason:
`Config` is already live on devnet at 137 bytes with no spare room, so growing
it would need a realloc of an account the migration instruction cannot itself
deserialize. A separate singleton costs one extra account read and leaves the
deployed config untouched. It also means **exits are off until an admin turns
them on**, since `request_exit` needs the account — the right default for a
staged rollout.

Two rules guard it. `MIN_EXIT_WINDOW_SLOTS` makes zero unrepresentable: a zero
window is not a short guarantee but no guarantee, request and claim in one
block with no room for a settlement between them. And `set_exit_window` will
not more than halve the window in one step, the same shape as the chip rate's
band, so walking thirty minutes down to the floor takes nine separate on-chain
transactions instead of one. The floor alone is a sanity bound, not a
substitute for choosing a real window; the shrink rule is what makes a quiet
collapse impossible.

The existing rules still apply to a claim: `remaining` is 0 or at least
`MIN_STAKE_CHIPS`, and the destination must be the owner's own account.

## Reconcile's third state

Today `reconcile` returns `{ mismatches, surpluses }` and reads
"less on chain than ledger" as the serious direction. A legitimate claim looks
exactly like a drained vault: the agent has no pending chain op, so it is not
skipped, and `onChain < ledger` puts it straight into `mismatches`.

Add a third bucket, computed rather than assumed:

```
shortfall   = ledger - onChain
explainedBy = claimed_amount of this agent's Exit PDA, if not yet ingested
unexplained = shortfall - explainedBy

unexplained == 0  → explained   ingest it; no alarm
unexplained  >  0  → mismatch    alarm, sized at unexplained, not at shortfall
unexplained  <  0  → surplus     money arrived; the existing path
```

Three things this gets right, and each of them is a way it could have been got
wrong:

- **Exact, not "at least".** A claim that coincides with a real drain reports
  the drain. Treating any pending exit as blanket permission to be short is how
  this design would hide the bug it exists to expose.
- **The evidence is on chain, not in our database.** `explainedBy` is read from
  the Exit PDA, not from a row we wrote when we thought we saw a claim. A
  server that missed the request still reconciles correctly.
- **Costs nothing in the common case.** Only read the Exit PDA when
  `onChain < ledger`. Agents that agree are one RPC call, as now.

`Explained` is a returned bucket, not a silent `continue`. The worker pass
ingests them, and a persistent `explained` — one that does not become
`onChain == ledger` on the next pass — is itself an alarm: it means ingestion
is broken.

## When a claim lands and the ledger has not caught up

The gap is one worker pass: the claim is on chain, the ledger still shows the
old balance.

**Can anything double-spend in it? No, and the reason is the window, not luck.**
The dangerous act is playing a match against money that has left. The agent was
frozen when the *request* was ingested — thirty minutes earlier. By claim time
it has not been matchable for half an hour. The claim→ingest gap is not a play
window.

The only real gap is **request→ingest**: the interval between `request_exit`
landing and the server noticing and freezing. It is bounded by one worker pass,
and it closes itself — a server that is down starts no matches, and a server
that is up has the remaining ~30 minutes to settle anything it started.

What survives: the server starts a match microseconds before it ingests the
request, then dies for more than thirty minutes. The claim succeeds and that
settlement never lands. Exposure is one match's worst case —
`max_settlement`, 60 chips. **Accepted, not mitigated**, decided 2026-09-26. A
reserve would strand 60 chips on every honest exit to cover a compound
failure; that is a bad trade. Recorded as limitation 12 in
[security.md](security.md#known-limitations).

**What the player sees.** Not the ledger. Once an exit is ingested the agent is
in an explicit `exiting` state with the unlock time, and the panel reads the
Exit PDA rather than the balance. When `claimed_slot` is set it says claimed
immediately, whatever the ledger still thinks. A player must never see "you
still have 900" after their wallet has the tokens.

**What the alarm does.** Nothing, for the duration of a correctly explained
gap — that is the whole point of the third state. The settlement-lag alarm is
untouched: it watches op age and an exit creates no op.

## Server changes — built

The watcher is `src/db/exits.ts`, run on its own clock by the chain worker
every 30 seconds. Its own clock because nothing in the outbox knows about
exits: an exit is owner-signed, so it reaches this server only by being looked
for. `exits()` reads every Exit account in one call, which is how a *request*
is noticed at all — a request moves no money, so no vault is short and nothing
else would ever look at that address.

**Frozen** is derived, not stored: an agent is frozen while it has an `exits`
row with `ingested_at` null. So setting `ingested_at` *is* the unfreeze, in the
same transaction as the ledger debit, and the two can never disagree. It bites
in three places — `runMatch` refuses to stake, `dueAgents` stops scheduling,
and `withdrawable` closes the instant co-signed path.

One case worth naming: a request that vanishes before this server saw a claim
is read as a cancel. It could in principle be a claim that was missed, and the
thing that makes it safe is the program refusing to close a claimed exit for a
whole window while passes run every thirty seconds. This is a **named
invariant** in [security.md](security.md#invariants), because it is reachable
through ordinary admin transactions: `MIN_EXIT_WINDOW_SLOTS` is four seconds,
shorter than one pass. If it breaks, the reconciler sees a vault short with
nothing explaining it and says so — the third state doing its job.

## Server changes

- **Watcher.** A worker pass reads the Exit PDA for agents with a live exit and
  for any agent reconcile finds short. Two events to ingest: *requested*
  (freeze the agent, stop autoplay, record the unlock slot) and *claimed*
  (debit the ledger, retire if it emptied). Idempotent on
  `(agent_id, requested_slot)`.
- **The ledger follows the chain here**, which is a reversal. Every other path
  debits first and lets the chain catch up. An ingest that runs twice must be a
  no-op, and an ingest that never runs must show up as a persistent
  `explained`.
- **Freeze** means: no matchmaking, no autoplay, no new deposit, and the
  existing instant withdrawal refused with a reason naming the exit.
- `withdrawable()` gains the exit states so one place still answers "what can
  this owner do now".

## The instant path stays the front door

The 30-minute path is the guarantee, not the product. A player should meet it
only when the server cannot co-sign.

- `POST /agents/:id/withdrawals` behaves exactly as it does now. When the
  server can co-sign, the slow path is **not mentioned at all** — no secondary
  button, no explanatory paragraph, nothing.
- It appears only when the instant path is refused, and then as the answer to
  that refusal: *we can't co-sign right now — you can start an exit that
  doesn't need us. It takes 30 minutes.*
- Never phrased as "safer", "trustless" or "recommended". It is slower and it
  exists for a situation the player is not in.

## The part our server cannot serve — built

An exit offered only by our web app is not non-custodial: if the server is
down, so is the button. So [`web/public/exit/`](../web/public/exit/) is two files — `index.html` and
`exit.mjs` — with no npm, no CDN, no build step and no call to our API. It
finds a wallet's agents from the program's own `AgentOwner` records, so it
works for an agent we have never heard of.

The price is base58, the ed25519 curve check, address derivation and
transaction serialization written out a second time. `test/standalone-exit.test.ts`
holds every one against `@solana/web3.js` byte for byte, so the copy cannot
drift. That test earned itself immediately: the first version got base58 wrong
for all-zero input — which is the System Program's id — so every
`request_exit` it built was one byte too long, and it would have failed only
in the hands of someone trying to leave.

## After a partial claim, the agent plays on

Decided 2026-09-26. Taking everything retires the agent, as it does today.
Taking part of it does not: an owner who left a playable balance left it on
purpose, and retiring them for it would be the wrong default.

**It unfreezes on ingest of the claim, not on the claim itself.** The chain
knows the vault is smaller the moment the claim lands; the ledger does not
until the watcher runs. Unfreezing on the claim would let the agent be matched
in exactly the gap where the two disagree, staking against money the ledger
still thinks is there. So the order is: claim lands → watcher ingests → ledger
debited → exit cleared → matchable. The agent stays frozen across the whole
gap, which is the same rule that makes the gap safe in the first place.

## Order of work

1. Program: `request_exit`, `claim_exit`, `close_exit`, the Exit account,
   `EXIT_WINDOW_SLOTS`. Tests against the local validator, including a claim
   racing a settlement. Report the `.so` size — 435,912 of 600,000 today, so
   there is room without `solana program extend`.
2. Deploy to devnet. Program changes ship before anything that uses them.
3. Reconcile's third state, with tests that a claim plus a real drain still
   reports the drain.
4. Watcher, freeze, ingest, unfreeze.
5. **The standalone exit page** — plain HTML, an RPC and a wallet, nothing
   else. Ahead of the in-app path, because it is the thing that makes the
   guarantee real; the in-app path is only convenience.
6. `withdrawable()` states and the API. **Built.** One owner-facing answer
   still comes from one place: `withdrawable()` carries the exit beside the
   balance, so nothing has to ask two questions to know what an owner can do.
   Read from the database rather than the chain, because every caller is
   rendering a page and a page that costs an RPC call per view stops working
   when the RPC does; `settled` says plainly whether the watcher has caught up.
7. In-app UI, instant path untouched. **Built.** `web/app/exit-panel.tsx`
   renders nothing at all in the ordinary case. It appears only when an exit
   is already under way - an owner needs to see that wherever they look - or
   when the instant path has just failed with a 5xx, which is the one refusal
   we cannot fix for them. It builds its transactions from the standalone
   page's own module, so the in-app route and the one that works when we are
   gone cannot disagree about what an exit is.

It cannot go earlier than 5, and the reason is worth stating rather than
rediscovering: **before step 4 exists, every use of the page is an
unexplained mismatch.** The ledger never learns the money left, the agent is
never unfrozen, and reconcile alarms correctly and forever. Built early and
proven on devnet by all means — that is the point of it owing nothing to this
server — but it must not be the advertised route until ingestion is there to
catch what it does.

## Open questions

1. **Seed-flow agents.** The seed program is frozen and its settler key is
   exposed, so this can only be built on v2. Seed agents retire at cutover;
   this assumes that has happened.
2. **`close_exit` after how long**, and does anyone but the owner need to call
   it? Rent is the owner's, so nobody else has an incentive.
