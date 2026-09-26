# Rehearsing an exit

A procedure, not a one-off. It is how "non-custodial" stops being a claim about
the code and becomes something that has been done: an owner takes their money
out of Oxude with a real wallet, and this server is asked for nothing.

Run it on devnet now, and again on mainnet before anything real is at stake.
The design it exercises is in [non-custodial-exit.md](non-custodial-exit.md).

## What it proves, and what it does not

It proves the whole path end to end: the program, the watcher, the ledger
following the chain, the freeze, and both front ends.

It does **not** prove the guarantee. The guarantee is that this works when our
servers do not, and both the in-app panel and `/exit` are served from our
hosting. Step 8 is the closest you can get without a second host.

## Before you start

Checked against devnet on 2026-09-26; re-check rather than trust these.

| | state | needed |
| --- | --- | --- |
| wallet `GRAia7es…` SOL | **0** | ~0.02. The owner pays their own fees on this path, unlike every other one. |
| stake tokens | 2,800 chips | 1,100 (200 rent + 900 deposit) |
| deposit-funded agents | 1, **retired, 0 chips** | a fresh one; a retired agent cannot play or be topped up |

So two things have to happen first, and neither is part of the test:

1. **Fund the wallet with devnet SOL** — https://faucet.solana.com. The exit
   costs about `0.00118` SOL of rent for its record (refunded at step 7) plus
   three signature fees. Everything else in Oxude is paid for by the settler;
   this path is the exception, and that is worth feeling once.
2. **Rent a fresh deposit-funded agent** at 200 chips rent and a 900 chip
   deposit, from the normal rent screen. Renting still costs you no SOL.

Note the new agent's id from its page URL: `/a/<agent-id>`.

## The test

Two exits: a partial one, which leaves a playable agent, and a full one, which
retires it. They exercise different code.

### 1 · Baseline

Open `/admin` and note three things. Everything below is a change from here.

- **Solvency → Difference** should read `+0`, *the books add up*.
- **Reconcile → Disagreements** should read `none`.
- **Volume → Agents in play** — remember the number.

### 2 · Start a partial exit

The in-app panel only offers an exit when the instant path has failed, which is
correct and makes it awkward to test. Use `/exit` instead — it is the same
three instructions and the same module.

1. Open `https://oxude.xyz/exit`.
2. RPC endpoint: leave it at devnet. **Connect wallet.**
3. Your agent should be listed — found from the program's own owner records,
   not from anything we hold. Pick it.
4. Vault holds should read **900**, exit window **4500 slots**.
5. Enter **300** and *Start the exit*. Sign.

**Check now.** The page should show `Unlocks: slot N (now M)` with N about 4,500
ahead. **Nothing has moved yet** — vault still 900. That is the point of a
request.

### 3 · Watch the freeze land

Within about 30 seconds the watcher sees the request.

- The agent's page: autoplay is **off**, and it says an exit is waiting.
- Its **Withdraw** panel refuses: *an exit is waiting on chain: claim or cancel
  it first*. The instant path is closed while the slow one is open.
- Press **Play** on the agent. It must refuse — *has an exit waiting on chain*.
- `/admin` is **unchanged**: Difference still `+0`. Nothing has moved, so
  nothing should have.

If the agent is still playable after a minute, stop: the watcher is not
running, and everything after this is meaningless.

### 4 · Optional — make the next step watchable

The interesting moment lasts one watcher pass. To see it rather than infer it,
widen the pass before claiming:

```
railway variables --service api --set CHAIN_EXIT_INTERVAL_MS=120000
railway redeploy --service api
```

Two minutes instead of thirty seconds. **Do not go above 180000**: the window
is 4,500 slots ≈ 1,800,000 ms and the server refuses to start at less than ten
times its own interval — which you can also prove, deliberately, by setting
`300000` and reading the startup log. Put it back to `30000` afterwards.

### 5 · Wait, then claim

Thirty minutes. The page counts down; the agent stays frozen throughout.

When it says the wait is over, press **Claim**. Sign.

**Check immediately** — this is the one state the whole design is about, and
with the default interval it lasts under 30 seconds:

- Your wallet gains **300** stake tokens.
- `/admin` → **Reconcile** shows *Explained by an owner's exit: 1*, and
  **Disagreements** still `none`. The vault is short of the ledger and the
  reconciler says why instead of alarming.
- `/admin` → **Solvency → Difference** reads about `−300`: *vaults hold less
  than the ledger says*. Correct and temporary.

If you miss it, that is the watcher being fast, not a failure. The durable
evidence is in the next step.

### 6 · Ingestion catches up

Within a pass:

- `/admin` → **Difference** back to `+0`, **Explained** gone.
- The agent's balance is **600**.
- It is **not retired**, and it plays again — press **Play**. A partial exit
  leaves a playable agent on purpose.
- Its event log carries `exit-requested` then `exit-claimed`.

### 7 · Reclaim the record's rent

On `/exit`, *Clear the record and get its rent back*. This is refused until a
window has passed since the claim — that record is the only on-chain evidence
the vault is legitimately short, and erasing it early would turn the
reconciler's explanation back into an alarm. Refusal here is the system
working. Come back and clear it later.

### 8 · The full exit, from a page we do not serve

Repeat from step 2 for the remaining **600**, with one change that is the whole
point: **save `oxude.xyz/exit` and `oxude.xyz/exit/exit.mjs` to a folder on
your machine and open `index.html` from disk.** No Oxude server is involved in
anything but the RPC.

Expect at the end:

- Wallet gains 600.
- Agent balance 0, **retired**, reason `withdrawn`.
- `/admin` → Difference `+0`, Disagreements `none`, **Agents in play** one
  lower than step 1.

## If something is wrong

| what you see | what it means |
| --- | --- |
| Agent still plays after step 3 | The watcher is not running. Check the api log for `exits:` at startup. |
| `/admin` shows a **Disagreement**, not *Explained* | The claim is not being recognised. This is the third state failing, and the money is genuinely unaccounted for. Stop and read `reconcile` in `src/chain/worker.ts`. |
| Difference stays negative after a pass | Ingestion is stuck. The `exits` row will have `ingested_at` null. |
| Claim fails with `ExitLocked` | The window has not passed. Slots are not exactly 400 ms; wait longer. |
| Claim fails with `ExitAlreadyClaimed` | It already worked. Check your wallet. |

## When it passes

Update [security.md](security.md) limitation 3: it currently says the mechanism
is built but unproven by a real wallet. After this, only the hosting caveat
remains.
