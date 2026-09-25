# Oxude

## $OXUDE contract address

```text
6LHnjWWn5qNvjwCsSo8ucWj5AZZjQP4d8yy79omGpump
```

That is the token on Solana **mainnet**, launched on pump.fun. It is not what the game is played with: matches are
staked with a devnet SPL token minted by the settlement program ([`8S5QVBtZ…wA1N7`](https://explorer.solana.com/address/8S5QVBtZcBoKdKVGGUH2tCDpnoLYBxtGrPYDTBwwA1N7?cluster=devnet)),
which has no value and cannot be bought. Holding $OXUDE does not let you play, and playing does not earn you $OXUDE —
the two connect at mainnet launch, which has not happened. [docs/economy.md](docs/economy.md) says what is still open.

Oxude is a game where you don't play — your agent does. You rent an agent, either one of four balanced presets or one you describe in plain English, and it plays short matches of bluff-and-fold against other people's agents, with every hand shown afterwards like a poker hand history. Matches are staked with a devnet SPL token held in per-agent vaults, and every result is settled and recorded on Solana.

**Play it:** **[oxude.xyz](https://oxude.xyz)**. Connect Phantom or Solflare (signing in costs nothing), rent an agent, press play.

**Follow:** [@OxudeAI](https://x.com/OxudeAI) on X

**Live on devnet:** program [`EKJHJ8js…n8kir`](https://explorer.solana.com/address/EKJHJ8jsuXQ9hzy4qPXMsAHDagA38C1pkDWoz3un8kir?cluster=devnet)

**The deposit-funded program is deployed beside it**, and nothing uses it yet. It is the shape mainnet needs: the stake
token is an ordinary mint made outside the program, with **no mint authority left**, so nothing — not the program, not
the admin key — can create currency. Renting costs a fee that is burned, funding is a deposit out of the owner's own
wallet, and both travel in one transaction the owner signs, so a fee can never be charged for a rental that did not
happen. Every agent on the live site is still on the seed-funded program above; the switch happens at a season
boundary ([docs/economy.md](docs/economy.md)).

| | |
|---|---|
| Program | [`HTs42VFp…tvkdy`](https://explorer.solana.com/address/HTs42VFpHS4XT9Cr8xH7cJEMgqPL9uuzZn6QHGwtvkdy?cluster=devnet) |
| Stake token | [`4DBM9NXi…828BV`](https://explorer.solana.com/address/4DBM9NXisEUsRbzyTDCL9HZjBkUGsAbdJEdSf9a828BV?cluster=devnet) — 6 decimals, 1,000,000,000 fixed, no mint authority |
| Rent | 200 chips, burned |
| Chip rate | 1 chip = 1 token, fixed on devnet |


A match played end to end on the live site: wallet connected, agent rented, match played, settled on devnet. The player's Mirage rental held the weakest possible hand, 0.30, raised into a stronger 0.40, and the opponent folded:

| | |
|---|---|
| The match | **[Mirage rental vs Hollowmere-1179](https://oxude.xyz/m/7acde14c-daae-419f-9d24-ea7c87ca0d1d)**: *Mirage rental raised 0.30 into 0.40 and took it*, won 14 |
| Settlement transaction | [`5Stov8CB…oosxGcC`](https://explorer.solana.com/tx/5Stov8CB16mBtxBbsU1E4iPug6hkBELyzuavNAESzG9gpQcaryT45X2c9np1nmbjhZwaXEJ2jpiRakPU1oosxGcC?cluster=devnet) |
| Settlement record (one per match) | [`EY8D647b…WCN1`](https://explorer.solana.com/address/EY8D647bgAmi6NM2VpFMkjreorGnf6B8ckkWNZv6WCN1?cluster=devnet) |
| Paying vault → receiving vault | [`Fmx3g5Lq…yw4vj`](https://explorer.solana.com/address/Fmx3g5LqzwzcwmdK4JFfupvCkUvVi3WpcTRfoU7yw4vj?cluster=devnet) → [`BcGEEkDH…LikDi`](https://explorer.solana.com/address/BcGEEkDHqpHMX3emGS9hk6dwi2LD221b9L8uCagLikDi?cluster=devnet) |
| Game currency mint | [`8S5QVBtZ…wA1N7`](https://explorer.solana.com/address/8S5QVBtZcBoKdKVGGUH2tCDpnoLYBxtGrPYDTBwwA1N7?cluster=devnet) |

That session also rented an agent from a written brief and played it. All 20 matches settled on devnet from the deployed API.

Security model and known limitations: **[docs/security.md](docs/security.md)**. Read it before treating any of this as more than a devnet demo.

---

## How a match works

Each round, both agents privately draw an edge from 0.30 to 0.70 — roughly, their chance of winning the round. Neither sees the other's. One agent acts first and the other answers: **fold** (pay the ante and lose the round), **call**, or **raise**. If nobody folds, a weighted coin decides the round for the base bet, or the raised bet if anyone raised. First to two rounds, at most three — so a match can move at most two rounds at the raised bet.

The amounts depend on the **band** you rent in, which is a money scale rather than a ceiling:

| Band | Ante | Bet | Raised | Most a match can move |
|---|---|---|---|---|
| A | 2 | 5 | 10 | 20 |
| B | 4 | 10 | 20 | 40 |
| C | 6 | 15 | 30 | 60 |

Every amount scales by the same factor, so the decision an agent faces is identical in all three and the presets stay exactly as balanced as they were measured to be. Agents are matched only against others in their own band. Nothing is clamped, so an agent plays a band only while its balance could pay that band's worst match outright.

Because the opponent's edge is hidden and a raise can be answered in the same round, a weak agent can raise and make a stronger one fold. That is a bluff, and whether it pays is the game.

## Running it

**Prerequisites:** Node 24 and npm. A Phantom or Solflare browser extension to sign in. For the chain: Rust, the Solana CLI (3.x) and Anchor 0.32.1.

```bash
npm install
npm run check                    # type-check and the test suite (229 tests)

docker compose up -d             # Postgres on :5432
export DATABASE_URL=postgres://oxude:oxude@localhost:5432/oxude
npm run serve -- --migrate       # API on :8787; migrates, seeds a house roster of 24 agents
npm run seed-bands               # optional: 8 more house agents in band A, then 8 in band C

cd web && npm install
npm run build && npm run start   # web app on :3000
```

Open http://localhost:3000, connect a wallet, rent a preset and press play. Any Postgres works; `--migrate` applies only migrations not yet applied, so it is safe on every start. For a throwaway run with no database, `npm run serve -- --migrate --memory` uses embedded PGlite in memory, and everything, share links included, is gone when it stops. The test suite always uses PGlite.

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | API | Needed to rent an agent from a written brief; read from the environment or a `.env` file in the repo root. Without it, presets work and briefs return 503. |
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

### Deployment

The live site runs on Railway: Postgres, the API (with the settlement worker) and the web app as three services.

**`railway up` uploads the git repository root, not the working directory.** The API deploys correctly from the repo root with `railway up -s api`, because the root `railway.json` is its config. The web app does not: its config is `web/railway.json`, but a CLI upload puts the repo root at the top of the build context, so Railway reads the root `railway.json`, starts `npm start` → `tsx scripts/serve.ts --migrate`, finds no `DATABASE_URL` and crash-loops. `cd web && railway up -s web` does not fix it, because the CLI still walks up to the git root.

The web service has its **Root Directory set to `/web`**, and current Railway (railpack v0.40) *does* apply that to a CLI upload — an earlier version of this note said it applied only to git-triggered builds. So the upload has to contain a `web/` directory for the setting to resolve: uploading the *contents* of `web/` fails at prepare with `Root directory "/web" was not found in the deployed source`. Nothing ships when that happens, so the site stays up.

Until the web service is connected to GitHub (see below), deploy it from a copy of `web/` placed outside the repository:

```
rm -rf /tmp/webdeploy && mkdir -p /tmp/webdeploy/web
tar -cf - --exclude=node_modules --exclude=.next -C web . | (cd /tmp/webdeploy/web && tar -xf -)
cd /tmp/webdeploy && railway up -s web --ci \
  --project af965879-57de-4ff2-89a0-efc0c9863fcd --environment production
```

**Check the deploy logs every time.** A correct web deploy logs `oxude-web@1.0.0 start` → `next start`. If it logs `oxude@0.0.1 start` → `tsx scripts/serve.ts`, the API build shipped to the web service and the site is down — Railway has marked such a deployment `SUCCESS` before the container began crash-looping, so the status alone is not enough. This has taken oxude.xyz down twice.

The API takes `DATABASE_URL`, `CHAIN_RPC_URL`, `CHAIN_SETTLER_SECRET` (the settler key's JSON byte array), `ANTHROPIC_API_KEY`, `CORS_ORIGIN`, `AUTH_DOMAIN`, `HOST=0.0.0.0` and `TRUST_PROXY=1`; the web app takes the three `NEXT_PUBLIC_*` variables at build time.

The site has one address. `www.oxude.xyz` (CNAME to Railway, on Vercel DNS) and the `*.up.railway.app` default domain both answer with a permanent 308 to `https://oxude.xyz`, keeping the path and query — see `web/proxy.ts`, which reads the apex from `NEXT_PUBLIC_SITE_URL`. So `CORS_ORIGIN` and `AUTH_DOMAIN` name the apex only: nothing reaches the API from a www origin.

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

**On-chain settlement** — `chain/`, `src/chain/`. An Anchor program with a 0-decimal SPL mint, a vault PDA per agent (funded when rented), and a settlement record PDA per match. Renting and settling write outbox rows; a worker submits them in order, stops at the first failure, and never sends twice. The ledger is authoritative; the chain records it, and a reconciler reports any disagreement. The program also enforces its own limits — only the settler key, at most `max_settlement` per match (60, which is exactly band C's worst match), each match once, and no more than a quarter of a vault's balance paid out per ten-minute window — so it doesn't simply trust the server.

**Auth** — `src/auth/`. Sign-in with a Solana wallet: a single-use nonce inside a message naming the site, verified as an ed25519 signature, exchanged for a session.

## How the design got here

The first version had both agents choosing at the same time, and the balance harness caught a problem immediately: **AlwaysRaise beat all four presets, by +4.04 chips a match.** The cause was structural. A fold cost 10, while calling even the worst hand cost at most 8 in expectation, so folding was never right and a player who always raised could only gain. Two rule changes that made folding cheaper each broke the preset balance instead, and a sweep over every ante from 3 to 9 found no value where AlwaysRaise stopped winning *and* the presets still beat each other in a loop.

The deeper problem was bluffing. With both agents choosing at once, a raise can never make the opponent fold *that round*, so a bluff has nothing to win. Switching to turn-based play, where the second agent can fold to a raise, looked like the fix. It wasn't: across **585 preset sets that passed every balance check, not one contained a bluff that ever made a stronger hand fold.** The reason was the draw itself — B's edge was always 1 − A's, so a player holding 0.3 *knew* the opponent held 0.7 and never had reason to believe the bluff.

Making the two draws independent gave the game hidden information. In the shipped set, opponents fold to Mirage's bluffs **48–67% of the time, about half of those while holding the stronger hand**, and bluffing is worth **+0.36 chips a match** to it — turning it off makes Mirage worse against every other preset. **435,821 preset sets** passed every check across antes 3–5; the shipped set is one of them, with the loop holding at every ante in that range.

The same habit of measuring shaped the rest:

- **Ratings.** A rolling average over 50 matches has a spread of ±5.6 chips, while the real gaps between presets are about 0.1. That couldn't rank anything, so the ladder ranks total winnings — a fact — and the exact rating stays private.
- **Starting balance.** At 60, 82% of agents went broke, half of them within 13 matches. 180 was right while a match could never move more than 40 and a ceiling clamped what was left. Once bands became money scales and the clamp went, a week of autoplay at one match per ten minutes needed more: at 900, 99% of band A agents last the week, 80% in band B and 61% in band C. Those figures are measured, not estimated — `npx tsx scripts/simulate-autoplay.ts` enumerates every draw and flip, and `--emit` regenerates the table the rent screen quotes.
- **Bands are money scales, not ceilings.** The old per-match ceiling decided who an agent met and clamped its results, which meant the top two bands played identically: a match could never move more than 40 anyway. A band now multiplies every amount by one factor — A ×0.5, B ×1, C ×1.5 — so the decision each agent faces is identical in all three and only what it is worth changes. Records are normalised back onto band B's scale, so the ladder ranks agents rather than the band they picked.

## Limitations

Stated plainly; details in [docs/security.md](docs/security.md).

- **The game is devnet and fake currency only.** No mainnet deployment of the game, and in-game balances have no value. $OXUDE is a real token on mainnet (`6LHnjWWn5qNvjwCsSo8ucWj5AZZjQP4d8yy79omGpump`), but it is not the game's currency: the two connect at mainnet launch, which has not happened. See [docs/economy.md](docs/economy.md) for what is still open.
- **Partly custodial.** Owners can withdraw from their agents' vaults, but a withdrawal needs the server's co-signature as well as the owner's, so the server can refuse or delay one. There is no way to deposit back.
- **A stolen settler key could drain vaults**, 60 at a time, by inventing match ids. Each settlement is capped, and so is the total: a vault pays out at most a quarter of its balance — never less than 120 — in each ten-minute window. Because that cap is read from the balance as it falls, a window in practice closes at about a fifth of what the vault held when it opened.
- **The admin key can upgrade the program**, and can raise the per-match limit through `set_max_settlement` (bounded by `MAX_SEED`, and refused to every other key including the settler's). It should be handed to a multisig or made immutable before anything real is at stake.
- **One agent in play per wallet.** A wallet can hold only one un-retired agent; renting another is refused until the current one retires, which happens when its balance is withdrawn in full or falls below what any band costs.
- **Briefs need an Anthropic API key.** Without one, only presets can be rented. The measurement of how much a brief actually changes play (`npm run brief-sweep`) has not yet been run against a live model.
- **The session token lives in browser storage**, readable by any script on the page.
- **Third-party RPC.** The deployed settlement worker settles through a Helius devnet endpoint rather than Solana's public one, which rate-limits shared cloud IPs. That removes the throttling but puts a third party on the path between the ledger and the chain.

## Repository

```
src/        engine, exact calculator, presets, agents, ledger, auth, chain client, HTTP API
chain/      the Anchor settlement program
web/        Next.js app: renting, playing, ladder, public match pages
scripts/    balance harness, preset search, seeding, deployment
test/       vitest suites; test/chain.test.ts runs against a local validator
docs/       security model; the economy and bands; how LLM agents plug in
```

More: [docs/security.md](docs/security.md) · [docs/economy.md](docs/economy.md) · [docs/ai-agents.md](docs/ai-agents.md)
