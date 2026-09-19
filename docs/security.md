# Security model

Oxude is a devnet demo with fake currency. This document says what it protects, how, and where it stops. Nothing here has been audited.

## What is at stake

Game tokens in per-agent vaults on Solana devnet, and the accuracy of the off-chain ledger that decides every movement. There is no mainnet deployment and nothing of real value.

## Who is trusted with what

| Party | Can do | Cannot do |
|---|---|---|
| A player (wallet) | Sign in; rent agents; play their own agents; change their own agents' ceilings; rate briefs; **withdraw from their own agents' vaults**, signing a transaction | Act for another wallet's agents; withdraw from anyone else's vault; withdraw without the server co-signing; see another player's brief, table or private rating |
| The model | Fill in a decision table once, when an agent is rented from a brief | Anything during a match; see any key; sign anything |
| The API server | Run matches, write the ledger, queue chain operations, prepare withdrawals | Move vault funds except through the program's `settle`, within its limits, or an owner-signed `withdraw` |
| The settler key (server) | Open vaults; settle matches, up to 60 each, each match once; record an agent's owner, once; co-sign withdrawals | Exceed the per-match limit; settle a match twice; withdraw without the owner's signature; change an owner once recorded |
| The admin key | Initialise the program; **upgrade it** | Nothing else at run time |

## Identity: wallet sign-in

`src/auth/wallet.ts`, `src/http/server.ts`.

- **Challenge.** `POST /auth/nonce` issues 16 random bytes, bound to one public key, valid for 5 minutes, rate limited per IP.
- **Message.** The wallet signs plain text naming the site ("*domain* wants you to sign in with your Solana account"), so a signature made for Oxude cannot be replayed on another site. It says signing costs nothing and triggers no transaction, because the signing prompt is where people get phished.
- **Verification.** The server rebuilds the exact message it issued and checks the ed25519 signature. It never trusts message text sent back by the client.
- **Replay.** A nonce is burnt with a conditional update, so two concurrent verifications of one signature cannot both open a session. Tested: a wrong-key signature, a replayed nonce, a nonce issued to another key, a tampered message and an expired nonce are all rejected.
- **Sessions.** 32 random bytes, returned once and stored only as a SHA-256 hash, valid 7 days, revoked on sign-out. Sent as `Authorization: Bearer`.
- **Email or X, through Privy (optional).** With `NEXT_PUBLIC_PRIVY_APP_ID` set, a Privy embedded Solana wallet can sign in too. It signs the same nonce message and the server verifies it the same way, so the owner is still the public key and nothing downstream knows the difference. The key lives in Privy's isolated iframe, not the page. Unset, no Privy code is loaded.

## Money: ledger and chain

`src/db/ledger.ts`, `src/db/runner.ts`, `src/chain/`, `chain/programs/oxude_settlement/`.

- **The ledger is authoritative.** Balances are sums of immutable ledger rows. A match, its ledger rows, both ratings and its chain operation are written in one database transaction, so they cannot disagree.
- **The server validates before anything moves.** A match's stake is limited by what both agents can cover and by one match's maximum exposure (60). An agent that cannot cover the minimum stake is refused a match and retired.
- **The chain records, in order.** An outbox worker submits vault openings and settlements strictly in order, stops at the first failure and retries from there. If an earlier attempt landed but its confirmation was lost, the vault or settlement record already exists, so the worker marks it done instead of sending it again.
- **The program checks again.** Only the configured settler can open vaults or settle. A settlement cannot exceed the per-match limit. A match settles at most once, because its record is a PDA seeded by the match id. Vault authority is a PDA, so no private key — the server's included — can move vault funds except through `settle`, or a `withdraw` the agent's owner signed. Each of these is tested on a local validator (`npm run test:chain`).
- **Reconciliation.** `reconcile` compares every fully settled agent's vault with its ledger balance and reports disagreements; it never overwrites either side.

## Withdrawals

`src/db/withdrawals.ts`, `chain/programs/oxude_settlement/` (`register_owner`, `withdraw`).

- **Owners are recorded on chain.** When an agent's vault opens, the settler records its owner in a PDA seeded by the agent id. The record can be created once and never changed, by anyone. Existing agents were backfilled the same way.
- **Two signatures.** A withdrawal needs the owner's signature, checked by the program against that record, so a non-owner can never withdraw. It also needs the settler's co-signature, which is the server saying nothing is in flight. Tokens can only go to the owner's own token account. The server pays the fee.
- **Nothing in flight.** The server refuses while any of the agent's settlements is still pending on chain. On top of that, the transaction states the balance the vault must be left with, taken from the ledger. If the vault disagrees because a settlement hasn't landed, the program refuses.
- **Empty or playable.** A withdrawal must leave either nothing, which retires the agent and freezes its record, or at least the minimum stake of 10.
- **Once.** Each withdrawal has an id, and its on-chain record is a PDA seeded by it, so it pays once. The server also accepts each prepared withdrawal's signed transaction once, and checks that it is byte for byte the transaction it prepared.
- **Ledger first.** The ledger row, the outbox row and any retirement are written in one database transaction, then the transaction is sent. While it is on its way, the agent can't play. If it can never land (its blockhash expired, or the program refused it), the ledger row is reversed, the retirement undone, and the queue carries on.

## The model

The model's only job is to fill in a 30-cell decision table from a brief, once, when an agent is rented. The table is validated (every cell must be fold, call or raise) and stored. Matches play the stored table; the model is not called during a match and has no access to keys, balances, other agents or the chain. The prompt is a pure function of the stakes and the brief, and a test checks it contains no seed or opponent information.

## Other protections

- **Rate limits**, per wallet or per IP: model-backed requests 5 a minute (each owner's first is free), matches 30 a minute, sign-in nonces 20 a minute.
- **Privacy of strategies.** Another player's brief, table and exact rating are never returned by the public views of an agent, the ladder, the roster, or match pages. Match transcripts show every hand played, by design — a player who studies transcripts and adapts is playing the game properly.
- **CORS** allows one configured web origin.

## Known limitations

These are real, and would each need fixing before anything of value were at stake.

1. **A stolen settler key could drain vaults.** The program limits each settlement to 60 and each match id to one settlement, but match ids are made up by the server. An attacker holding the settler key could invent new ids and settle 60 at a time until vaults are empty. The per-match limit caps each transaction, not the total. Mitigations would include an on-chain rate limit per vault, or settlements that require evidence the server cannot fabricate alone.
2. **The admin key can upgrade the program**, and so could replace every rule above. It should move to a multisig, or the program should be made immutable.
3. **Still partly custodial.** Owners can withdraw, but only with the server's co-signature, so the server can refuse or delay a withdrawal. There is no way to deposit back into a vault.
4. **The settler key is a hot key on the server.** Locally it lives in a file (`.keys/settler.json`); on the deployed site it is a Railway service variable (`CHAIN_SETTLER_SECRET`), readable by anyone with access to that Railway project. There is no HSM, no signing service, no key rotation.
5. **The session token is in browser `localStorage`**, readable by any script running on the page. It grants the app's actions, not wallet authority. Serving the API through Next.js on the same origin would allow an HttpOnly cookie instead.
6. **Nonces and sessions are not garbage-collected.** Expired rows accumulate.
7. **Rate limits are in memory**, per process. They reset on restart and are not shared across instances.
8. **Each settlement record costs the settler about 0.0015 SOL in rent.** At scale this is a steady SOL drain; old records could be closed to recover it, but there is no instruction for that yet. Each withdrawal likewise leaves a record, and the first one per owner also creates their token account, both paid by the settler.
9. **Unaudited.** The program, the auth flow and the ledger have tests, not an audit.
10. **Privy is third-party script in the page.** With the flag on, Privy's SDK runs alongside the session token in `localStorage` (limitation 5), and it contacts Privy's servers and WalletConnect's wallet directory. A compromise of that SDK could read the session token, which grants the app's actions but no wallet authority. Embedded wallets are also custodial in Privy's sense: recovery depends on the user's email or X account.
11. **Owner records come from the server.** The settler records each agent's owner once. Until an agent's record lands (just after it is rented), a stolen settler key could record itself as that agent's owner, and then sign both halves of a withdrawal. The fix would be for the owner to register themselves, with a signature, instead of the server.

## Reporting

This is a demo. If you find something, open an issue.
