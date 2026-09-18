# Oxude

Oxude is a game where you don't play — your agent does. You rent an agent, either one of four balanced presets or one you describe in plain English, and it plays short matches of bluff-and-fold against other people's agents, with every hand shown afterwards like a poker hand history. Matches are staked with a devnet SPL token held in per-agent vaults, and every result is settled and recorded on Solana.

**Live on devnet:** program [`EKJHJ8js…n8kir`](https://explorer.solana.com/address/EKJHJ8jsuXQ9hzy4qPXMsAHDagA38C1pkDWoz3un8kir?cluster=devnet)

A match played end to end through the app — wallet connected, agent rented, match played, settled on devnet. The player's Mirage rental held the weakest possible hand, 0.30, raised into a stronger 0.40, and the opponent folded:

| | |
|---|---|
| The match | *Mirage rental* vs *Quarrel-6842*: *Mirage rental raised 0.30 into 0.40 and took it*, won 24 |
| Settlement transaction | [`3ZQ9YNxz…Neziw2oX`](https://explorer.solana.com/tx/3ZQ9YNxzrHuarHFmTHX8KGujaJvYXNyhRRVtMY94qMtRY5DX8URopVPx9tS7icoisFyBGcUxQPSwKFhQNeziw2oX?cluster=devnet) |
| Settlement record (one per match) | [`FYubPKSK…ZhKwh`](https://explorer.solana.com/address/FYubPKSKLDQcUEmZYW25AiTGCfmuAhUHVdtZTGGbhKwh?cluster=devnet) |
| Paying vault → receiving vault | [`G3Z8k6Qt…WLA`](https://explorer.solana.com/address/G3Z8k6QtQiZkHFeSCimCpxAJx6waPJFJxrZP1qpGPLWA?cluster=devnet) → [`EKKgu1ey…DkD`](https://explorer.solana.com/address/EKKgu1eyPG8rf8tJSz875cDPrz11MrYSTop4rXPuKDkD?cluster=devnet) |
| Game currency mint | [`8S5QVBtZ…wA1N7`](https://explorer.solana.com/address/8S5QVBtZcBoKdKVGGUH2tCDpnoLYBxtGrPYDTBwwA1N7?cluster=devnet) |
| Match id (share page `/m/<id>`) | `dae1ad35-545f-4aa1-a510-187da370390f` |

Six matches from that session settled against a persistent Postgres; all six transactions succeeded on devnet, reconciliation found all 25 vaults equal to the off-chain ledger, and every match page still resolved after Postgres, the API and the web app were restarted. There is no public deployment yet, so share pages are served by a local run.

Security model and known limitations: **[docs/security.md](docs/security.md)**. Read it before treating any of this as more than a devnet demo.

---

## How a match works

Each round, both agents privately draw an edge from 0.30 to 0.70 — roughly, their chance of winning the round. Neither sees the other's. One agent acts first and the other answers: **fold** (pay a 4-chip ante and lose the round), **call**, or **raise**. If nobody folds, a weighted coin decides the round for 10 chips, or 20 if anyone raised. First to two rounds, at most three.

Because the opponent's edge is hidden and a raise can be answered in the same round, a weak agent can raise and make a stronger one fold. That is a bluff, and whether it pays is the game.

## Running it

**Prerequisites:** Node 24 and npm. A Phantom or Solflare browser extension to sign in. For the chain: Rust, the Solana CLI (3.x) and Anchor 0.32.1.

```bash
npm install
npm run check                    # type-check and the test suite (183 tests)

docker compose up -d             # Postgres on :5432
export DATABASE_URL=postgres://oxude:oxude@localhost:5432/oxude
npm run serve -- --migrate       # API on :8787; migrates, seeds a house roster of 24 agents

cd web && npm install
npm run build && npm run start   # web app on :3000
```

Open http://localhost:3000, connect a wallet, rent a preset and press play. Any Postgres works; `--migrate` applies only migrations not yet applied, so it is safe on every start. For a throwaway run with no database, `npm run serve -- --migrate --memory` uses embedded PGlite in memory, and everything, share links included, is gone when it stops. The test suite always uses PGlite.

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | API | Needed to rent an agent from a written brief. Without it, presets work and briefs return 503. |
| `CHAIN_RPC_URL` | API | Settle to a chain, e.g. `https://api.devnet.solana.com`. Without it, settlements queue in the outbox. |
| `CHAIN_SETTLER_KEYPAIR` | API | Settler key, default `.keys/settler.json`. |
| `DATABASE_URL` | API | Postgres connection string. Required unless `--memory` is passed. |
| `AUTH_DOMAIN`, `CORS_ORIGIN` | API | Domain named in the sign-in message; allowed web origin. |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` | web, build time | API location; absolute URLs for share previews. |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | web, build time | Cluster for explorer links on match pages, default `devnet`. |

### Settling on chain

```bash
npm run chain:build    # anchor build; copies the IDL into src/chain
npm run test:chain     # the program's own tests, on a local validator
```

To deploy your own copy: generate `.keys/admin.json` and `.keys/settler.json` with `solana-keygen new`, run `anchor keys sync` in `chain/` (the deployed program's keypair is not in the repo, so a fresh build gets its own program id), fund the admin key with about 3 devnet SOL, then:

```bash
scripts/chain-deploy.sh devnet
CHAIN_RPC_URL=https://api.devnet.solana.com DATABASE_URL=... npm run serve -- --migrate
```

## Architecture

```
 browser ──wallet signature──▶ HTTP API ──▶ runner ──▶ engine (match)
                                  │            │
                                  │            ├──▶ ledger + outbox   (Postgres, one transaction)
                                  │            │
                           exact calculator    └──▶ worker ──▶ settlement program (Solana)
```

**Engine** — `src/engine.ts`, `src/round.ts`. A pure, deterministic TypeScript match: seeded PRNG, turn order, the draw, resolution. The same seed and agents always produce the same match, so every stored match replays exactly from its seed and rules.

**Agents are decision tables** — `src/presets.ts`, `src/agents/`. A strategy is 30 cells: an action for each of five edges in six situations. The four presets (Anchor, Hammer, Mirage, Bully) are tables. An agent rented from a brief asks the model once, at rent time, to fill in a table, which is stored with the agent; the model is never called during a match and never signs anything.

**Exact calculator** — `src/exact.ts`. Because agents are tables, a matchup's expected value can be computed exactly by enumerating every draw and coin flip — no sampling noise. It was used to balance the presets, and in the product it rates a brief against today's roster before you rent, privately. The public ladder ranks what agents actually won, not this number.

**Off-chain ledger** — `src/db/`. Postgres through Drizzle. Every movement of money is a ledger row and balances are sums of rows, never an updated column. A match, its ledger rows, both ratings and its chain op are written in one transaction.

**On-chain settlement** — `chain/`, `src/chain/`. An Anchor program with a 0-decimal SPL mint, a vault PDA per agent (funded when rented), and a settlement record PDA per match. Renting and settling write outbox rows; a worker submits them in order, stops at the first failure, and never sends twice. The ledger is authoritative; the chain records it, and a reconciler reports any disagreement. The program also enforces its own limits — only the settler key, at most 60 per match, each match once — so it doesn't simply trust the server.

**Auth** — `src/auth/`. Sign-in with a Solana wallet: a single-use nonce inside a message naming the site, verified as an ed25519 signature, exchanged for a session.

## How the design got here

The first version had both agents choosing at the same time, and the balance harness caught a problem immediately: **AlwaysRaise beat all four presets, by +4.04 chips a match.** The cause was structural. A fold cost 10, while calling even the worst hand cost at most 8 in expectation, so folding was never right and a player who always raised could only gain. Two rule changes that made folding cheaper each broke the preset balance instead, and a sweep over every ante from 3 to 9 found no value where AlwaysRaise stopped winning *and* the presets still beat each other in a loop.

The deeper problem was bluffing. With both agents choosing at once, a raise can never make the opponent fold *that round*, so a bluff has nothing to win. Switching to turn-based play, where the second agent can fold to a raise, looked like the fix. It wasn't: across **585 preset sets that passed every balance check, not one contained a bluff that ever made a stronger hand fold.** The reason was the draw itself — B's edge was always 1 − A's, so a player holding 0.3 *knew* the opponent held 0.7 and never had reason to believe the bluff.

Making the two draws independent gave the game hidden information. In the shipped set, opponents fold to Mirage's bluffs **48–67% of the time, about half of those while holding the stronger hand**, and bluffing is worth **+0.36 chips a match** to it — turning it off makes Mirage worse against every other preset. **435,821 preset sets** passed every check across antes 3–5; the shipped set is one of them, with the loop holding at every ante in that range.

The same habit of measuring shaped the rest:

- **Ratings.** A rolling average over 50 matches has a spread of ±5.6 chips, while the real gaps between presets are about 0.1. That couldn't rank anything, so the ladder ranks total winnings — a fact — and the exact rating stays private.
- **Starting balance.** At 60, 82% of agents went broke, half of them within 13 matches. At 180, about a quarter go broke, typically around match 30: common enough to see, rare enough not to be the default.

## Limitations

Stated plainly; details in [docs/security.md](docs/security.md).

- **Devnet and fake currency only.** No mainnet deployment, no real value.
- **Custodial.** Players never hold their tokens and cannot withdraw; the vaults are controlled by the program and settled by the server's key.
- **A stolen settler key could drain vaults**, 60 at a time, by inventing match ids. The program limits each settlement, not the total.
- **The admin key can upgrade the program.** It should be handed to a multisig or made immutable before anything real is at stake.
- **Briefs need an Anthropic API key.** Without one, only presets can be rented. The measurement of how much a brief actually changes play (`npm run brief-sweep`) has not yet been run against a live model.
- **The session token lives in browser storage**, readable by any script on the page.
- **Not publicly hosted.** Match pages and share cards work, but only where the web app and API are running; there is no public deployment yet.

## Repository

```
src/        engine, exact calculator, presets, agents, ledger, auth, chain client, HTTP API
chain/      the Anchor settlement program
web/        Next.js app: renting, playing, ladder, public match pages
scripts/    balance harness, preset search, seeding, deployment
test/       vitest suites; test/chain.test.ts runs against a local validator
docs/       security model; how LLM agents plug in
```

More: [docs/security.md](docs/security.md) · [docs/ai-agents.md](docs/ai-agents.md)
