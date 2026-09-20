# Security model

Oxude is a devnet demo with fake currency. This document says what it protects, how, and where it stops. Nothing here has been audited.

## What is at stake

Game tokens in per-agent vaults on Solana devnet, and the accuracy of the off-chain ledger that decides every movement. There is no mainnet deployment and nothing of real value.

## Who is trusted with what

| Party | Can do | Cannot do |
|---|---|---|
| A player (wallet) | Sign in; rent agents; play their own agents; move their own agents between bands their balance covers; rate briefs; **withdraw from their own agents' vaults**, signing a transaction | Act for another wallet's agents; withdraw from anyone else's vault; withdraw without the server co-signing; see another player's brief, table or private rating |
| The model | Fill in a decision table once, when an agent is rented from a brief | Anything during a match; see any key; sign anything |
| The API server | Run matches, write the ledger, queue chain operations, prepare withdrawals | Move vault funds except through the program's `settle`, within its limits, or an owner-signed `withdraw` |
| The settler key (server) | Open vaults, up to 900 each and 18,000 per window between them; settle matches, up to `max_settlement` each (60), each match once, and up to a quarter of any one vault's balance per window (never less than 120); co-sign withdrawals | Exceed those limits; settle a match twice; withdraw without the owner's signature; record anyone but the owner an agent's id derives from; change `max_settlement` |
| The admin key | Initialise the program; **upgrade it**; change `max_settlement` within `MAX_SEED`; **rotate the settler** with `set_settler` | Open vaults, settle, or withdraw; take the settler's role itself |

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
- **The server validates before anything moves.** A match is played at its band's scale, and the band's worst match - two rounds at the raised bet, so 20, 40 or 60 - is what each side risks. Nothing is clamped: both agents must be able to pay that worst case outright before the match is played at all, and an agent that cannot is refused. It is retired only when no band is affordable to it, below band A's 20.
- **The chain records, in order.** An outbox worker submits vault openings and settlements in the order the ledger recorded them. If the chain is unreachable it stops at the first op it cannot send and starts there next time. If the program refuses an op — a vault that has paid out its limit for this window, say — that op waits for the next pass while the rest carry on, so one throttled vault doesn't hold up everyone else; the program's own balance checks mean an op that overtakes one it depends on is refused too, and lands later. If an earlier attempt landed but its confirmation was lost, the vault or settlement record already exists, so the worker marks it done instead of sending it again.
- **The program checks again.** Only the configured settler can open vaults or settle. A settlement cannot exceed the per-match limit. A match settles at most once, because its record is a PDA seeded by the match id. Vault authority is a PDA, so no private key — the server's included — can move vault funds except through `settle`, or a `withdraw` the agent's owner signed. Each of these is tested on a local validator (`npm run test:chain`).
- **Rate limits in the program.** No vault can pay out more than `outflow_cap` through settlements in a window of 1,500 slots (about ten minutes), counted in a per-agent account the program keeps. That cap is a quarter of what the vault holds, never below 120, and it is read from the balance *before* each payment leaves - so it falls as the vault pays, and a window in practice closes at about a fifth of the balance it opened with. A vault opens with at most 900, and all vaults opened in one window mint at most 18,000 between them. These bound what a stolen settler key can take or print per window, rather than letting it empty every vault in one pass (limitation 1).
- **`max_settlement` is admin-settable.** The per-match cap is stored on the config rather than compiled in, so a band with bigger stakes can be priced in without a program upgrade. Only the admin recorded at initialisation can change it - never the settler, whose reach the cap exists to bound - and it is refused above `MAX_SEED`, so a stolen admin key cannot switch the guard off. The other limits above remain constants, so changing them still means an upgrade.
- **Reconciliation.** `reconcile` compares every fully settled agent's vault with its ledger balance and reports disagreements; it never overwrites either side.

## Withdrawals

`src/db/withdrawals.ts`, `src/agent-id.ts`, `chain/programs/oxude_settlement/` (`open_owned_vault`, `withdraw`).

- **An agent id belongs to its owner.** A new agent's id is the first 16 bytes of `sha256("oxude-agent-v1" || owner's key || random salt)`, as a UUID. Opening its vault recomputes that hash and records the owner in a PDA seeded by the id, in the same instruction. So the only owner that can ever be recorded for an agent is the one its id derives from: a stolen settler key cannot name itself, and there is no window before a record lands in which it could (limitation 11). A house agent's id hashes 32 zero bytes in the owner's place, so it has no owner and nothing can be withdrawn from it. Agents rented before this had random ids and owner records written by the settler; those records stand, created once and unchangeable.
- **Two signatures.** A withdrawal needs the owner's signature, checked by the program against that record, so a non-owner can never withdraw. It also needs the settler's co-signature, which is the server saying nothing is in flight. Tokens can only go to the owner's own token account. The server pays the fee.
- **Nothing in flight.** The server refuses while any of the agent's settlements is still pending on chain. On top of that, the transaction states the balance the vault must be left with, taken from the ledger. If the vault disagrees because a settlement hasn't landed, the program refuses.
- **Empty or playable.** A withdrawal must leave either nothing, which retires the agent and freezes its record, or enough to keep playing. The server holds that floor at 20, the cheapest band's worst match, because below it no band is affordable and the agent would be left holding money it could never play. The program enforces a looser floor of its own, `MIN_STAKE` 10, so a vault is never left with dust.
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

1. **A stolen settler key could still drain vaults, slowly.** Match ids are made up by the server, so an attacker holding the settler key can invent them and settle into a vault of their own. The program's rate limits bound this to a quarter of each vault per window of about ten minutes - a fifth in practice, as the cap falls with the balance - and 18,000 newly minted per window across all new vaults, instead of everything at once. A fresh vault holds 900, so a determined attacker needs several windows rather than one pass: the limits buy time to notice and upgrade the program, they do not stop the theft. Settlements that need evidence the server cannot fabricate alone would.
2. **The admin key can upgrade the program**, and so could replace every rule above. It should move to a multisig, or the program should be made immutable.
3. **Still partly custodial.** Owners can withdraw, but only with the server's co-signature, so the server can refuse or delay a withdrawal. There is no way to deposit back into a vault.
4. **The settler key is a hot key on the server.** Locally it lives in a file (`.keys/settler.json`); on the deployed site it is a Railway service variable (`CHAIN_SETTLER_SECRET`), readable by anyone with access to that Railway project. There is no HSM, no signing service, and no way to rotate the settler key without upgrading the program — so the only response to a theft is an upgrade by the admin key.
5. **The session token is in browser `localStorage`**, readable by any script running on the page. It grants the app's actions, not wallet authority. Serving the API through Next.js on the same origin would allow an HttpOnly cookie instead.
6. **Nonces and sessions are not garbage-collected.** Expired rows accumulate.
7. **Rate limits are in memory**, per process. They reset on restart and are not shared across instances.
8. **Each settlement record costs the settler about 0.0015 SOL in rent.** At scale this is a steady SOL drain; old records could be closed to recover it, but there is no instruction for that yet. Each withdrawal likewise leaves a record, and the first one per owner also creates their token account, both paid by the settler.
9. **Unaudited.** The program, the auth flow and the ledger have tests, not an audit.
10. **Privy is third-party script in the page.** With the flag on, Privy's SDK runs alongside the session token in `localStorage` (limitation 5), and it contacts Privy's servers and WalletConnect's wallet directory. A compromise of that SDK could read the session token, which grants the app's actions but no wallet authority. Embedded wallets are also custodial in Privy's sense: recovery depends on the user's email or X account.
11. **The settlement path runs through a third party.** The deployed worker settles through a Helius devnet RPC endpoint rather than Solana's public one, whose rate limits on shared cloud IPs made settlements slow. That endpoint sees every settlement before it reaches the chain and could delay or drop one; it cannot forge one, because the settler's signature is made locally. The ledger stays authoritative and the reconciler still reports a disagreement.
12. **Renting doesn't prove consent.** An agent's id binds it to its owner, so nobody can record a different one, but the server still creates the agent without the owner signing anything. It could create an agent "owned" by a wallet that never asked for one, which gives that wallet tokens and takes nothing. A transaction signed by the owner at rent time would prove consent; it would cost a signing step and make the agent wait to play.

## Before mainnet

Nothing here is optional. This is a devnet demo today; each item is a thing that
must be true before any of it holds real money.

**Rotate every production credential.** All four were exposed in a terminal
session on 2026-09-20 and must be replaced, not merely re-scoped:

- [ ] `ANTHROPIC_API_KEY` — revoke and reissue in the Anthropic console.
- [ ] `CHAIN_RPC_URL` — roll the Helius API key.
- [ ] `DATABASE_URL` — change the Postgres password in Railway.
- [ ] `CHAIN_SETTLER_SECRET` — generate a fresh settler keypair, point the
      config at it with `set_settler` (admin-signed), then update the Railway
      variable. The old key keeps no powers once the config moves.

Read variables with `railway variables -s <service> --json` and take the key
names; printing the table puts the values on screen.

**Then the rest:**

- [ ] Hand the admin key to a multisig, or make the program immutable. It can
      upgrade the program, rotate the settler and raise the per-match limit.
- [ ] Close the known limitations below, particularly 1 (a stolen settler key
      can still drain slowly) and 4 (the settler is a hot key on the server).
- [ ] Get an audit. The program, the auth flow and the ledger have tests, not an
      audit.
- [ ] Recompute every survival figure from the player's deposit rather than the
      fixed seed — see [economy.md](economy.md), open question 3.

## Reporting

This is a demo. If you find something, open an issue.
