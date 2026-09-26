//! Oxude settlement on Solana.
//!
//! The off-chain ledger is authoritative: it decides every movement, after the
//! server has validated the match against both balances. This program records
//! those decisions on chain and holds the currency, and it independently limits
//! what the server's key can do:
//!
//! - only the configured settler key can open vaults or settle, and only the
//!   admin can point the config at a different one;
//! Every amount here is in the stake token's base units, six decimals, never in
//! chips. The game is played in chips and the ledger converts them at the
//! season's rate, which the config carries as `chip_rate`: the base units in
//! one chip. The limits below are chip-denominated ideas - band A's worst
//! match, band C's worst match - so each is written as chips and multiplied by
//! that rate, rather than frozen as a base-unit number that would mean a
//! different amount of money every season.
//!
//! - a single settlement can never move more than `max_settlement`, which only
//!   the admin key can change and never above `MAX_SETTLEMENT_CEILING_CHIPS`
//!   converted at the rate; and no
//!   vault can pay out more than `outflow_cap` of its own balance through
//!   settlements in one window of `WINDOW_SLOTS` - so a stolen settler key
//!   drains slowly enough to be stopped;
//! - nothing here can create currency. The stake token is an ordinary mint made
//!   outside this program and handed to `initialize`, which refuses it unless
//!   its mint authority has already been given up. Every balance therefore
//!   traces to a deposit somebody made from their own wallet, or to a match
//!   won from another vault;
//! - an agent id is bound to its owner: it is the hash of the owner's key and
//!   a salt, checked as the vault opens, and the owner is recorded in that same
//!   instruction. No key - the settler's included - can record anyone else as
//!   the owner of that agent;
//! - each match settles at most once, and each rental is paid for at most once,
//!   because each has a record that is a PDA seeded by its id and cannot be
//!   created twice;
//! - renting costs a fee, burned out of the renter's own tokens, at the price
//!   the config carries. The price is checked against the amount in the
//!   instruction, so a price that moves while a player is signing makes their
//!   transaction fail rather than charging them something they did not see;
//! - vaults are PDAs whose authority is the config PDA, so no private key -
//!   the server's included - can move vault funds except through `settle`
//!   and `withdraw`;
//! - a withdrawal needs the agent's owner to sign, checked against the owner
//!   recorded on chain (set as the vault opens, never changed), and the
//!   settler to co-sign;
//!   it goes only to the owner's own token account, must leave the vault at
//!   exactly the balance the ledger says (so an unsettled match makes it
//!   refuse), must leave it empty or playable, and happens at most once per
//!   withdrawal id.
//!
//! No model is involved in anything here. An agent's decision table produces a
//! match result off chain; the server validates it; only then does the settler
//! sign a settlement.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

declare_id!("HTs42VFpHS4XT9Cr8xH7cJEMgqPL9uuzZn6QHGwtvkdy");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const OWNER_SEED: &[u8] = b"owner";
pub const WITHDRAWAL_SEED: &[u8] = b"withdrawal";
pub const OUTFLOW_SEED: &[u8] = b"outflow";
pub const RENTAL_SEED: &[u8] = b"rental";
pub const EXIT_SEED: &[u8] = b"exit";
pub const EXIT_CONFIG_SEED: &[u8] = b"exit_config";
/// Mixed into every agent id, so an id can't be confused with any other hash.
pub const AGENT_ID_DOMAIN: &[u8] = b"oxude-agent-v1";
/// A rate-limit window: about ten minutes of slots.
pub const WINDOW_SLOTS: u64 = 1_500;
/// The most base units one chip may ever cost, which is equivalently a floor on
/// the market cap: with a billion tokens issued and a chip pegged near a cent,
/// a thousand tokens to the chip is a ten-thousand-dollar cap. Below that the
/// rate clamps instead of following, so a tiny early cap cannot make one chip
/// cost an absurd share of the supply.
pub const MAX_CHIP_RATE: u64 = 1_000 * 1_000_000;
/// How long the rate must stand before it can move again: six days of slots,
/// safely inside a seven-day season.
///
/// This bounds how *often* the rate can move, not *when*. The season boundary
/// is a wall-clock Monday and the ledger owns it; slot times drift, so a
/// slot-derived week would sometimes refuse a change that was on time. What
/// this stops is an admin compounding several ±50% moves inside a day, which
/// the per-change band alone would allow.
pub const MIN_RATE_INTERVAL_SLOTS: u64 = 6 * 24 * 60 * 60 * 1_000 / 400;
/// The stake token's decimals. Not needed by any arithmetic here - `chip_rate`
/// carries the whole conversion - but checked at `initialize` so that a
/// deployment cannot be pointed at a token of a different scale, where every
/// figure the product quotes would be out by a factor of a thousand.
pub const STAKE_DECIMALS: u8 = 6;
/// The hard ceiling on `max_settlement`, in chips, so that even a stolen admin
/// key cannot turn the per-settlement guard off. Vaults are funded by deposit
/// and have no ceiling of their own, which is why this one is written out
/// rather than borrowed from a seed amount that no longer exists.
pub const MAX_SETTLEMENT_CEILING_CHIPS: u64 = 900;
/// The least one vault can pay out through settlements in one window, in chips.
/// A small vault is allowed this much even though a quarter of it is less.
pub const OUTFLOW_FLOOR_CHIPS: u64 = 120;
/// The exit window this deployment is set up with: about thirty minutes of
/// slots.
///
/// This is the whole safety argument for an exit that nobody co-signs. A
/// match's result exists in the server's ledger before it exists here, so a
/// withdrawal taken in that gap can take money already owed to someone else.
/// The window is the server's chance to settle what it owes before the money
/// leaves, and it is sized against the two clocks that already exist: the
/// outflow window is `WINDOW_SLOTS` (~10 minutes) and the server's settlement
/// lag alarm fires at 15 minutes. Thirty clears both with room.
///
/// In slots rather than wall clock, like every other interval here. Slots
/// running slow makes the window *longer*, which is the safe direction: more
/// time to settle, and the owner waits a little more.
///
/// A default, not a law: the live value is in `ExitConfig`, so the window can
/// follow the settlement alarm without a program upgrade.
pub const DEFAULT_EXIT_WINDOW_SLOTS: u64 = 4_500;
/// The shortest window the program will accept, ever.
///
/// Its job is to make a window of zero unrepresentable. A zero window is not a
/// short guarantee, it is no guarantee: `request_exit` and `claim_exit` in the
/// same block, with no chance for a settlement to land between them, which is
/// precisely the race the whole design exists to close.
///
/// It is not a substitute for choosing a real window. Four seconds of slots is
/// enough to refuse zero and the absurd, not enough to settle anything. What
/// stops a live deployment being walked down to it is the other rule:
/// `set_exit_window` will not more than halve the window in one step, so
/// collapsing thirty minutes takes nine separate admin transactions, each of
/// them on chain and visible. Against an admin key willing to do that, the
/// upgrade authority is the larger exposure anyway (security.md, limitation 2).
pub const MIN_EXIT_WINDOW_SLOTS: u64 = 10;
/// The least a vault may be left holding, in chips, if it is not left empty.
///
/// **Not** a band's worst match, and deliberately below the cheapest one - band
/// A's is 20. This program does not know the bands and should not: they are the
/// product's arrangement of the same money, and they have already changed once.
/// What this asks is only that a withdrawal leave a vault empty or non-trivial,
/// so that nobody is left holding dust they can neither play nor withdraw.
///
/// The server keeps its own, stricter floor at the cheapest band's cover
/// (src/db/withdrawals.ts), which is what an owner actually runs into. This one
/// sits underneath as a backstop that holds even if that rule is wrong, which
/// is the whole reason for having two.
pub const MIN_STAKE_CHIPS: u64 = 10;

#[program]
pub mod oxude_settlement {
    use super::*;

    /// One-time setup: the config, pointed at the stake token.
    ///
    /// The mint is passed in rather than created here, and it is refused unless
    /// its mint authority is already `None`. That is the whole of the supply
    /// guarantee: this program holds no authority to mint, and neither does
    /// anyone else, so the currency cannot be inflated after this call.
    pub fn initialize(
        ctx: Context<Initialize>,
        settler: Pubkey,
        max_settlement: u64,
        rent: u64,
        chip_rate: u64,
    ) -> Result<()> {
        require!(chip_rate > 0, OxudeError::InvalidLimit);
        require!(max_settlement > 0, OxudeError::InvalidLimit);
        require!(max_settlement <= in_base_units(MAX_SETTLEMENT_CEILING_CHIPS, chip_rate)?, OxudeError::InvalidLimit);
        require!(rent > 0, OxudeError::InvalidLimit);
        require!(ctx.accounts.mint.decimals == STAKE_DECIMALS, OxudeError::WrongStakeDecimals);
        require!(ctx.accounts.mint.mint_authority.is_none(), OxudeError::MintableStakeToken);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.settler = settler;
        config.mint = ctx.accounts.mint.key();
        config.max_settlement = max_settlement;
        config.rent = rent;
        config.chip_rate = chip_rate;
        // Zero means the rate has never moved, so the first change need not
        // wait out an interval that has not started.
        config.chip_rate_slot = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Sets the season's rate: how many base units one chip is worth.
    ///
    /// The admin supplies a number computed off chain from a published
    /// time-weighted average price, and the program holds it to three bounds it
    /// can check for itself: it may not move by more than half either way, it
    /// may not exceed `MAX_CHIP_RATE`, and it may not move again for
    /// `MIN_RATE_INTERVAL_SLOTS`. Those bound what a wrong or dishonest reading
    /// can do; they do not make one acceptable. An on-chain oracle can take the
    /// admin's place later without changing any of the three.
    ///
    /// `max_settlement` is a chip figure held in base units, so it is rescaled
    /// here rather than left to mean a different number of chips than it did
    /// yesterday - which also means a falling rate can never strand it above
    /// the ceiling and make the next change impossible.
    pub fn set_chip_rate(ctx: Context<SetChipRate>, chip_rate: u64) -> Result<()> {
        require!(chip_rate > 0, OxudeError::InvalidLimit);
        require!(chip_rate <= MAX_CHIP_RATE, OxudeError::RateCeiling);
        let slot = Clock::get()?.slot;
        let config = &mut ctx.accounts.config;
        require!(rate_interval_passed(config.chip_rate_slot, slot), OxudeError::RateTooSoon);
        require!(rate_within_band(config.chip_rate, chip_rate), OxudeError::RateMoveTooBig);
        let previous = config.chip_rate;
        config.max_settlement = config
            .max_settlement
            .checked_mul(chip_rate)
            .and_then(|scaled| scaled.checked_div(previous))
            .ok_or(OxudeError::RateOverflow)?;
        config.chip_rate = chip_rate;
        config.chip_rate_slot = slot;
        emit!(ChipRateChanged { previous, chip_rate, max_settlement: config.max_settlement });
        Ok(())
    }

    /// Sets what renting an agent costs, in base units. The admin recorded at
    /// initialize is the only key that can call it.
    ///
    /// On mainnet a season's rent is a fixed value in dollars converted at that
    /// season's rate, so this is called once per boundary, in the same
    /// transaction as the rate it was computed from.
    ///
    /// Nobody can be overcharged by a change landing at the wrong moment: the
    /// amount is an argument to `pay_rent`, so a player whose price moved while
    /// they were signing gets a failed transaction, not a bigger bill.
    pub fn set_rent(ctx: Context<SetRent>, rent: u64) -> Result<()> {
        require!(rent > 0, OxudeError::InvalidLimit);
        let config = &mut ctx.accounts.config;
        let previous = config.rent;
        config.rent = rent;
        emit!(RentChanged { previous, rent });
        Ok(())
    }

    /// Pays for a rental by burning the fee out of the renter's own tokens.
    ///
    /// Burned, not collected: the fee leaves the supply rather than moving to
    /// the platform, so renting takes tokens off the market instead of funding
    /// a wallet. The record makes a rental id unrepeatable, so a retried
    /// transaction cannot charge twice.
    ///
    /// At rent time this is the first of three instructions the owner signs in
    /// one transaction - the fee, the vault, the deposit - so a paid fee can
    /// never be left behind by a rental that did not happen.
    pub fn pay_rent(ctx: Context<PayRent>, rental_id: [u8; 16], amount: u64) -> Result<()> {
        require!(amount == ctx.accounts.config.rent, OxudeError::WrongRent);
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.source.to_account_info(),
                    authority: ctx.accounts.renter.to_account_info(),
                },
            ),
            amount,
        )?;
        let record = &mut ctx.accounts.rental;
        record.rental_id = rental_id;
        record.renter = ctx.accounts.renter.key();
        record.amount = amount;
        record.slot = Clock::get()?.slot;
        record.bump = ctx.bumps.rental;
        emit!(RentPaid { rental_id, renter: record.renter, amount });
        Ok(())
    }

    /// Raises or lowers the most a single settlement can move. The admin
    /// recorded at initialize is the only key that can call it - not the
    /// settler, whose reach this value is there to limit in the first place.
    /// It exists so a band with bigger stakes can be priced in without another
    /// program upgrade, and it is bounded by `MAX_SETTLEMENT_CEILING_CHIPS` at
    /// the season's rate, so that a stolen admin key cannot turn the
    /// per-settlement guard off altogether.
    pub fn set_max_settlement(ctx: Context<SetMaxSettlement>, max_settlement: u64) -> Result<()> {
        require!(max_settlement > 0, OxudeError::InvalidLimit);
        let ceiling = in_base_units(MAX_SETTLEMENT_CEILING_CHIPS, ctx.accounts.config.chip_rate)?;
        require!(max_settlement <= ceiling, OxudeError::InvalidLimit);
        let config = &mut ctx.accounts.config;
        let previous = config.max_settlement;
        config.max_settlement = max_settlement;
        emit!(MaxSettlementChanged { previous, max_settlement });
        Ok(())
    }

    /// Points the config at a new settler key. The admin recorded at initialize
    /// is the only key that can call it.
    ///
    /// Without this a compromised settler could only be answered by upgrading
    /// the program, which is slow at exactly the moment speed matters. It
    /// refuses the key already in place, so a call that would change nothing
    /// fails loudly rather than looking like a rotation that happened. It also
    /// refuses the admin's own key: one key holding both roles would undo the
    /// separation every other check here depends on.
    pub fn set_settler(ctx: Context<SetSettler>, settler: Pubkey) -> Result<()> {
        require!(settler != Pubkey::default(), OxudeError::InvalidSettler);
        let config = &mut ctx.accounts.config;
        require!(settler != config.settler, OxudeError::InvalidSettler);
        require!(settler != config.admin, OxudeError::InvalidSettler);
        let previous = config.settler;
        config.settler = settler;
        emit!(SettlerChanged { previous, settler });
        Ok(())
    }

    /// Opens a house agent's empty vault. It is funded by `deposit`, like any
    /// other, because there is nothing here that can create currency.
    pub fn open_vault(_ctx: Context<OpenVault>, agent_id: [u8; 16], salt: [u8; 16]) -> Result<()> {
        require!(agent_id == agent_id_for(&Pubkey::default(), &salt), OxudeError::AgentIdMismatch);
        emit!(VaultOpened { agent_id, owner: None });
        Ok(())
    }

    /// Opens a player's agent's empty vault and records its owner, together.
    /// The agent id must be the hash of that owner's key and the salt, so this
    /// is the only owner the agent can ever have: whoever sends it, the settler
    /// included, can't record another, and the record can't be created twice.
    ///
    /// The money arrives separately, through `deposit`, which the renting
    /// transaction carries in the same instruction list.
    pub fn open_owned_vault(
        ctx: Context<OpenOwnedVault>,
        agent_id: [u8; 16],
        salt: [u8; 16],
        owner: Pubkey,
    ) -> Result<()> {
        require!(owner != Pubkey::default(), OxudeError::AgentIdMismatch);
        require!(agent_id == agent_id_for(&owner, &salt), OxudeError::AgentIdMismatch);
        let record = &mut ctx.accounts.agent_owner;
        record.agent_id = agent_id;
        record.owner = owner;
        record.bump = ctx.bumps.agent_owner;
        emit!(VaultOpened { agent_id, owner: Some(owner) });
        Ok(())
    }

    /// Moves tokens from a wallet into an agent's vault. This is how every
    /// vault is funded: by its owner at rent time and whenever they top it up,
    /// and for a house agent by whoever runs the roster.
    ///
    /// The depositor signs and the tokens are their own. The program does not
    /// check that they are the agent's owner, and could not usefully: a vault
    /// is an ordinary token account, so a plain SPL transfer reaches it without
    /// coming through here at all. What this instruction adds is the event - a
    /// credit that names the agent and the wallet it came from, so the ledger
    /// can attribute it instead of finding a surplus it cannot explain.
    ///
    /// Depositing into someone else's agent is therefore allowed. It gives that
    /// agent money, which is nobody's loss but the depositor's.
    pub fn deposit(ctx: Context<Deposit>, agent_id: [u8; 16], amount: u64) -> Result<()> {
        require!(amount > 0, OxudeError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(Deposited { agent_id, depositor: ctx.accounts.depositor.key(), amount });
        Ok(())
    }

    /// Moves a match's settled net from the loser's vault to the winner's, and
    /// records it. The amount was decided and validated off chain; this checks
    /// the bounds again and refuses to settle the same match twice.
    pub fn settle(
        ctx: Context<Settle>,
        match_id: [u8; 16],
        from_agent: [u8; 16],
        to_agent: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, OxudeError::ZeroAmount);
        require!(amount <= ctx.accounts.config.max_settlement, OxudeError::OverLimit);
        require!(from_agent != to_agent, OxudeError::SameAgent);
        require!(ctx.accounts.from_vault.amount >= amount, OxudeError::InsufficientVault);
        let slot = Clock::get()?.slot;
        let outflow = &mut ctx.accounts.outflow;
        outflow.bump = ctx.bumps.outflow;
        // Measured on what the vault holds now, before this settlement leaves it.
        let cap = outflow_cap(ctx.accounts.from_vault.amount, ctx.accounts.config.chip_rate);
        (outflow.window_start, outflow.spent) = charge(outflow.window_start, outflow.spent, slot, amount, cap)
            .ok_or(OxudeError::OutflowLimit)?;

        let bump = ctx.accounts.config.bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from_vault.to_account_info(),
                    to: ctx.accounts.to_vault.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        let record = &mut ctx.accounts.settlement;
        record.match_id = match_id;
        record.from_agent = from_agent;
        record.to_agent = to_agent;
        record.amount = amount;
        record.slot = slot;
        record.bump = ctx.bumps.settlement;
        emit!(Settled { match_id, from_agent, to_agent, amount });
        Ok(())
    }

    /// Moves tokens from an agent's vault to its owner. The owner must sign,
    /// and must be the owner recorded on chain; the settler co-signs to say
    /// nothing is in flight. `remaining` is what the ledger says the vault
    /// holds afterwards: if the vault disagrees, a settlement hasn't landed yet
    /// and this refuses. The vault is left empty or playable, never between.
    pub fn withdraw(
        ctx: Context<Withdraw>,
        withdrawal_id: [u8; 16],
        agent_id: [u8; 16],
        amount: u64,
        remaining: u64,
    ) -> Result<()> {
        require!(amount > 0, OxudeError::ZeroAmount);
        let held = ctx.accounts.vault.amount;
        require!(held >= amount, OxudeError::InsufficientVault);
        require!(held - amount == remaining, OxudeError::LedgerMismatch);
        let min_stake = in_base_units(MIN_STAKE_CHIPS, ctx.accounts.config.chip_rate)?;
        require!(remaining == 0 || remaining >= min_stake, OxudeError::Unplayable);

        let bump = ctx.accounts.config.bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        let record = &mut ctx.accounts.withdrawal;
        record.withdrawal_id = withdrawal_id;
        record.agent_id = agent_id;
        record.owner = ctx.accounts.owner.key();
        record.amount = amount;
        record.remaining = remaining;
        record.slot = Clock::get()?.slot;
        record.bump = ctx.bumps.withdrawal;
        emit!(Withdrawn { withdrawal_id, agent_id, owner: record.owner, amount, remaining });
        Ok(())
    }

    /// Turns exits on, with the window they wait.
    ///
    /// Its own account rather than a field on `Config`, and the reason is
    /// concrete: `Config` is already live on devnet at 137 bytes with no room
    /// spare, so growing it would need a realloc of an account that the
    /// migration instruction cannot itself deserialize. A separate singleton
    /// costs one more account read and leaves the deployed config untouched.
    ///
    /// It also means exits are off until an admin turns them on: `request_exit`
    /// needs this account, so a deployment that has not created it has no exit
    /// path at all. That is the right default for rolling this out.
    pub fn init_exit_config(ctx: Context<InitExitConfig>, slots: u64) -> Result<()> {
        require!(slots >= MIN_EXIT_WINDOW_SLOTS, OxudeError::ExitWindowTooShort);
        let c = &mut ctx.accounts.exit_config;
        c.slots = slots;
        c.bump = ctx.bumps.exit_config;
        emit!(ExitWindowChanged { previous: 0, slots });
        Ok(())
    }

    /// Moves the exit window.
    ///
    /// Lengthening is free: a longer window only means more time to settle and
    /// a longer wait for the owner, both safe. Shortening is capped at half
    /// per step, the same shape as the chip rate's band, so that walking a
    /// live deployment down to nothing takes many transactions rather than
    /// one, and every one of them is on chain.
    pub fn set_exit_window(ctx: Context<SetExitWindow>, slots: u64) -> Result<()> {
        require!(slots >= MIN_EXIT_WINDOW_SLOTS, OxudeError::ExitWindowTooShort);
        let c = &mut ctx.accounts.exit_config;
        let previous = c.slots;
        require!(window_shrink_ok(previous, slots), OxudeError::ExitWindowShrinkTooFast);
        c.slots = slots;
        emit!(ExitWindowChanged { previous, slots });
        Ok(())
    }

    /// Starts an exit that this server does not co-sign.
    ///
    /// The owner alone signs, and alone pays. Nothing moves here: this records
    /// the intent and starts the clock, and `claim_exit` pays out once
    /// the configured window has passed. The gap is the point - it is the
    /// server's chance to settle every match this agent has already played,
    /// before money that may already be owed elsewhere leaves the vault.
    ///
    /// One exit per agent, because the PDA is seeded by the agent alone. A
    /// second request while one is live fails on the account already existing,
    /// which is what we want: an owner closes the first or claims it.
    pub fn request_exit(ctx: Context<RequestExit>, agent_id: [u8; 16], amount: u64) -> Result<()> {
        require!(amount > 0, OxudeError::ZeroAmount);
        let slot = Clock::get()?.slot;
        let exit = &mut ctx.accounts.exit;
        exit.agent_id = agent_id;
        exit.owner = ctx.accounts.owner.key();
        exit.amount = amount;
        exit.requested_slot = slot;
        exit.unlock_slot = slot.saturating_add(ctx.accounts.exit_config.slots);
        // Recorded for the server, not used by any rule here: a vault smaller
        // at claim than at request is a settlement having landed in the
        // window, which is the system working.
        exit.vault_at_request = ctx.accounts.vault.amount;
        exit.claimed_slot = 0;
        exit.claimed_amount = 0;
        exit.bump = ctx.bumps.exit;
        emit!(ExitRequested { agent_id, owner: exit.owner, amount, unlock_slot: exit.unlock_slot });
        Ok(())
    }

    /// Pays out an exit whose window has passed. The owner signs; nobody else
    /// is needed, which is the whole point of it.
    ///
    /// Pays `min(requested, vault)`, because the window is allowed to have
    /// taken money out: a settlement that landed while this waited is exactly
    /// what the wait was for. It cannot overdraw, and it does not fail because
    /// the vault shrank.
    ///
    /// If the remainder would be unplayable dust, this takes the lot instead
    /// of refusing. Refusing would be the custodial answer - it assumes a
    /// server is standing by to work out a better number and ask again - and
    /// an exit that can fail on arithmetic the owner cannot see is not a
    /// guarantee. Taking everything is always the owner's own money and always
    /// leaves a valid vault.
    pub fn claim_exit(ctx: Context<ClaimExit>, agent_id: [u8; 16]) -> Result<()> {
        let slot = Clock::get()?.slot;
        let exit = &ctx.accounts.exit;
        require!(exit.claimed_slot == 0, OxudeError::ExitAlreadyClaimed);
        require!(slot >= exit.unlock_slot, OxudeError::ExitLocked);

        let held = ctx.accounts.vault.amount;
        require!(held > 0, OxudeError::ZeroAmount);
        let min_stake = in_base_units(MIN_STAKE_CHIPS, ctx.accounts.config.chip_rate)?;
        let amount = exit_payout(exit.amount, held, min_stake);

        let bump = ctx.accounts.config.bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        let exit = &mut ctx.accounts.exit;
        exit.claimed_slot = slot;
        exit.claimed_amount = amount;
        emit!(ExitClaimed { agent_id, owner: exit.owner, amount, remaining: held - amount });
        Ok(())
    }

    /// Clears an exit and returns its rent to the owner.
    ///
    /// Before a claim this is a cancel, and needs no wait: changing your mind
    /// costs nobody anything.
    ///
    /// After a claim it waits one window, and that wait is
    /// load-bearing. A claimed exit is the only evidence on chain that the
    /// vault is legitimately smaller than the server's ledger. Erase it before
    /// the server has read it and the shortfall becomes indistinguishable from
    /// a drained vault: the reconciler alarms, correctly, and never stops. So
    /// the record outlives the claim by as long as the server had to settle in
    /// the first place.
    pub fn close_exit(ctx: Context<CloseExit>, _agent_id: [u8; 16]) -> Result<()> {
        let exit = &ctx.accounts.exit;
        if exit.claimed_slot > 0 {
            let slot = Clock::get()?.slot;
            require!(
                slot >= exit.claimed_slot.saturating_add(ctx.accounts.exit_config.slots),
                OxudeError::ExitEvidenceNeeded
            );
        }
        Ok(())
    }
}

/// An agent's id: the first 16 bytes of the hash of the domain, its owner's
/// key (all zeros for a house agent) and a salt.
pub fn agent_id_for(owner: &Pubkey, salt: &[u8; 16]) -> [u8; 16] {
    let hash = hashv(&[AGENT_ID_DOMAIN, owner.as_ref(), salt]).to_bytes();
    let mut id = [0u8; 16];
    id.copy_from_slice(&hash[..16]);
    id
}

/// The most this vault can pay out through settlements in one window: a quarter
/// of what it holds, but never less than `OUTFLOW_FLOOR_CHIPS` at the season's
/// rate. Proportional so that a large vault is not held to a small one's limit.
///
/// `settle` reads this from the balance before each payment leaves, so the cap
/// falls as the vault pays and what it has already spent chases a falling
/// target. A window therefore closes at a fifth of the balance it opened with,
/// not a quarter: spending stops once `spent > (start - spent) / 4`, which is
/// `spent > start / 5`. A vault holding 900 pays out 180 in a window and keeps
/// 720. That is deliberate - the declining cap is the conservative reading, and
/// it only bites when one agent is being farmed by a crowd, which the ledger
/// throttles first. Above the floor, no snapshot is stored.
///
/// Note that with deposits there is no ceiling on what a vault may hold, so a
/// quarter of a large one is a large number. An absolute per-window ceiling
/// alongside this proportional one is on the pre-mainnet list (docs/security.md).
pub fn outflow_cap(vault: u64, chip_rate: u64) -> u64 {
    OUTFLOW_FLOOR_CHIPS.saturating_mul(chip_rate).max(vault / 4)
}

/// Whether a new rate is within half of the one in place, either way. A token
/// that doubles or halves in a week moves the chip rate by half, and the rest
/// is caught up the week after.
pub fn rate_within_band(previous: u64, next: u64) -> bool {
    match (next.checked_mul(2), previous.checked_mul(3)) {
        (Some(twice), Some(thrice)) => twice >= previous && twice <= thrice,
        _ => false,
    }
}

/// Whether the rate has stood long enough to move again. A rate that has never
/// moved may move at once.
pub fn rate_interval_passed(last_slot: u64, slot: u64) -> bool {
    last_slot == 0 || slot >= last_slot.saturating_add(MIN_RATE_INTERVAL_SLOTS)
}

/// An amount in chips as base units of the stake token, at the season's rate.
/// Every chip-denominated limit in this program goes through here, so none of
/// them is a base-unit number frozen at one season's prices.
pub fn in_base_units(chips: u64, chip_rate: u64) -> Result<u64> {
    chips.checked_mul(chip_rate).ok_or(OxudeError::RateOverflow.into())
}

/// A fixed-window budget: `(window_start, spent)` after charging `amount` at
/// `slot`, or None if it would go over `cap`. A window that has run its course
/// starts again from this slot.
/// Whether the exit window may move from `previous` to `next`.
///
/// Growing is always fine. Shrinking is capped at half in one step, so walking
/// a window down to the floor takes many visible transactions instead of one.
/// `saturating_mul` rather than `*`: doubling a window near `u64::MAX` would
/// otherwise overflow, and the answer for an absurdly large `next` is plainly
/// yes.
pub fn window_shrink_ok(previous: u64, next: u64) -> bool {
    next.saturating_mul(2) >= previous
}

/// What a claim pays out: at most what was asked, at most what is there, and
/// never leaving dust behind.
///
/// The clamp to `held` is the window doing its job - a settlement that landed
/// while the exit waited is money that was never the owner's, and the claim
/// simply takes less rather than failing.
///
/// The dust rule rounds **up**, to the whole vault. Refusing would be the
/// custodial answer: it assumes a server is standing by to work out a better
/// number and ask again, and an exit that can fail on arithmetic the owner
/// cannot see is not a guarantee. Taking everything is always the owner's own
/// money and always leaves a valid vault.
pub fn exit_payout(asked: u64, held: u64, min_stake: u64) -> u64 {
    let pay = asked.min(held);
    let remainder = held - pay;
    if remainder > 0 && remainder < min_stake {
        held
    } else {
        pay
    }
}

pub fn charge(window_start: u64, spent: u64, slot: u64, amount: u64, cap: u64) -> Option<(u64, u64)> {
    let (start, spent) = if slot >= window_start.saturating_add(WINDOW_SLOTS) { (slot, 0) } else { (window_start, spent) };
    let spent = spent.checked_add(amount)?;
    (spent <= cap).then_some((start, spent))
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// The only key that can open vaults and settle.
    pub settler: Pubkey,
    pub mint: Pubkey,
    /// The most a single settlement can move.
    pub max_settlement: u64,
    /// What renting an agent costs, in base units. Burned, not collected.
    pub rent: u64,
    /// Base units in one chip, for this season. Every chip-denominated limit
    /// here is converted through it.
    pub chip_rate: u64,
    /// The slot the rate last moved at; 0 until it first does.
    pub chip_rate_slot: u64,
    pub bump: u8,
}

/// One per match: its existence is what stops a match settling twice.
#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub match_id: [u8; 16],
    pub from_agent: [u8; 16],
    pub to_agent: [u8; 16],
    pub amount: u64,
    pub slot: u64,
    pub bump: u8,
}

/// One per rental paid for: its existence is what stops a fee being charged
/// twice for the same rental.
#[account]
#[derive(InitSpace)]
pub struct Rental {
    pub rental_id: [u8; 16],
    pub renter: Pubkey,
    pub amount: u64,
    pub slot: u64,
    pub bump: u8,
}

/// One per agent with an owner: who may withdraw from its vault.
#[account]
#[derive(InitSpace)]
pub struct AgentOwner {
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    pub bump: u8,
}

/// One per withdrawal: its existence is what stops a withdrawal paying twice.
#[account]
#[derive(InitSpace)]
pub struct Withdrawal {
    pub withdrawal_id: [u8; 16],
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining: u64,
    pub slot: u64,
    pub bump: u8,
}

/// One per agent that has paid out through a settlement: its current window.
#[account]
#[derive(InitSpace)]
pub struct Outflow {
    pub window_start: u64,
    pub spent: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SetSettler<'info> {
    /// The admin recorded on the config, and nobody else.
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OxudeError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetChipRate<'info> {
    /// The admin recorded on the config, and nobody else.
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OxudeError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetRent<'info> {
    /// The admin recorded on the config, and nobody else.
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OxudeError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(rental_id: [u8; 16])]
pub struct PayRent<'info> {
    /// Pays the fee out of their own tokens, and signs for the burn.
    pub renter: Signer<'info>,
    /// Co-signs and pays this record's account rent, as it does for every other
    /// account this program opens.
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// The renter's own token account, and nobody else's.
    #[account(
        mut,
        token::mint = config.mint,
        constraint = source.owner == renter.key() @ OxudeError::NotRentersAccount
    )]
    pub source: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = settler,
        space = 8 + Rental::INIT_SPACE,
        seeds = [RENTAL_SEED, rental_id.as_ref()],
        bump
    )]
    pub rental: Account<'info, Rental>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetMaxSettlement<'info> {
    /// The admin recorded on the config, and nobody else.
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OxudeError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// The stake token: an ordinary mint made outside this program, whose mint
    /// authority has already been given up. Checked in `initialize`.
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct OpenVault<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = settler,
        token::mint = mint,
        token::authority = config,
        seeds = [VAULT_SEED, agent_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct OpenOwnedVault<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = settler,
        token::mint = mint,
        token::authority = config,
        seeds = [VAULT_SEED, agent_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = settler,
        space = 8 + AgentOwner::INIT_SPACE,
        seeds = [OWNER_SEED, agent_id.as_ref()],
        bump
    )]
    pub agent_owner: Account<'info, AgentOwner>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct Deposit<'info> {
    /// Whoever is paying. Signs for the transfer out of their own account.
    pub depositor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// The depositor's own token account for the stake token, and nobody else's.
    #[account(
        mut,
        token::mint = config.mint,
        constraint = source.owner == depositor.key() @ OxudeError::NotDepositorsAccount
    )]
    pub source: Account<'info, TokenAccount>,
    /// Seeded by the agent id, so the event cannot name one agent while the
    /// money goes to another.
    #[account(mut, seeds = [VAULT_SEED, agent_id.as_ref()], bump, token::mint = config.mint)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 16], from_agent: [u8; 16], to_agent: [u8; 16])]
pub struct Settle<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [VAULT_SEED, from_agent.as_ref()], bump, token::mint = config.mint)]
    pub from_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED, to_agent.as_ref()], bump, token::mint = config.mint)]
    pub to_vault: Account<'info, TokenAccount>,
    /// The paying vault's outflow window, made the first time it pays.
    #[account(
        init_if_needed,
        payer = settler,
        space = 8 + Outflow::INIT_SPACE,
        seeds = [OUTFLOW_SEED, from_agent.as_ref()],
        bump
    )]
    pub outflow: Account<'info, Outflow>,
    #[account(
        init,
        payer = settler,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, match_id.as_ref()],
        bump
    )]
    pub settlement: Account<'info, Settlement>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(withdrawal_id: [u8; 16], agent_id: [u8; 16])]
pub struct Withdraw<'info> {
    /// Co-signs to say nothing is in flight, and pays the fees and rent.
    #[account(mut)]
    pub settler: Signer<'info>,
    /// Must be the owner recorded on chain for this agent.
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler)]
    pub config: Account<'info, Config>,
    #[account(seeds = [OWNER_SEED, agent_id.as_ref()], bump = agent_owner.bump, has_one = owner @ OxudeError::NotOwner)]
    pub agent_owner: Account<'info, AgentOwner>,
    #[account(mut, seeds = [VAULT_SEED, agent_id.as_ref()], bump, token::mint = config.mint)]
    pub vault: Account<'info, TokenAccount>,
    /// The owner's own token account for the game currency, and nobody else's.
    #[account(
        mut,
        token::mint = config.mint,
        constraint = destination.owner == owner.key() @ OxudeError::NotOwnersAccount
    )]
    pub destination: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = settler,
        space = 8 + Withdrawal::INIT_SPACE,
        seeds = [WITHDRAWAL_SEED, withdrawal_id.as_ref()],
        bump
    )]
    pub withdrawal: Account<'info, Withdrawal>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

/// A live or spent exit, one per agent.
///
/// Seeded by the agent alone - deliberately not by an id the owner picks -
/// so that the server can find any agent's exit at a deterministic address
/// without having been told anything. Everything downstream depends on that:
/// an exit the server cannot find is an exit it cannot ingest, and a
/// shortfall it cannot explain.
#[account]
#[derive(InitSpace)]
pub struct Exit {
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    /// What the owner asked for. The claim pays at most this, and at most what
    /// the vault still holds.
    pub amount: u64,
    pub requested_slot: u64,
    /// Not before this slot may it be claimed.
    pub unlock_slot: u64,
    /// What the vault held when this was requested, for the server to compare.
    pub vault_at_request: u64,
    /// 0 until claimed. Non-zero is what tells the reconciler that a smaller
    /// vault is explained rather than drained.
    pub claimed_slot: u64,
    pub claimed_amount: u64,
    pub bump: u8,
}

/// The live exit window, in slots. One per deployment.
#[account]
#[derive(InitSpace)]
pub struct ExitConfig {
    pub slots: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitExitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OxudeError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + ExitConfig::INIT_SPACE,
        seeds = [EXIT_CONFIG_SEED],
        bump
    )]
    pub exit_config: Account<'info, ExitConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetExitWindow<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ OxudeError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [EXIT_CONFIG_SEED], bump = exit_config.bump)]
    pub exit_config: Account<'info, ExitConfig>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct RequestExit<'info> {
    /// Signs and pays. No settler here - that is the point of this path.
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [EXIT_CONFIG_SEED], bump = exit_config.bump)]
    pub exit_config: Account<'info, ExitConfig>,
    #[account(seeds = [OWNER_SEED, agent_id.as_ref()], bump = agent_owner.bump, has_one = owner @ OxudeError::NotOwner)]
    pub agent_owner: Account<'info, AgentOwner>,
    #[account(seeds = [VAULT_SEED, agent_id.as_ref()], bump, token::mint = config.mint)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + Exit::INIT_SPACE,
        seeds = [EXIT_SEED, agent_id.as_ref()],
        bump
    )]
    pub exit: Account<'info, Exit>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct ClaimExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [OWNER_SEED, agent_id.as_ref()], bump = agent_owner.bump, has_one = owner @ OxudeError::NotOwner)]
    pub agent_owner: Account<'info, AgentOwner>,
    #[account(mut, seeds = [VAULT_SEED, agent_id.as_ref()], bump, token::mint = config.mint)]
    pub vault: Account<'info, TokenAccount>,
    /// The owner's own token account for the game currency, and nobody else's.
    #[account(
        mut,
        token::mint = config.mint,
        constraint = destination.owner == owner.key() @ OxudeError::NotOwnersAccount
    )]
    pub destination: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [EXIT_SEED, agent_id.as_ref()],
        bump = exit.bump,
        has_one = owner @ OxudeError::NotOwner
    )]
    pub exit: Account<'info, Exit>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct CloseExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [EXIT_CONFIG_SEED], bump = exit_config.bump)]
    pub exit_config: Account<'info, ExitConfig>,
    #[account(
        mut,
        close = owner,
        seeds = [EXIT_SEED, agent_id.as_ref()],
        bump = exit.bump,
        has_one = owner @ OxudeError::NotOwner
    )]
    pub exit: Account<'info, Exit>,
}

#[event]
pub struct ExitWindowChanged {
    pub previous: u64,
    pub slots: u64,
}

#[event]
pub struct ExitRequested {
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    pub amount: u64,
    pub unlock_slot: u64,
}

#[event]
pub struct ExitClaimed {
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct Withdrawn {
    pub withdrawal_id: [u8; 16],
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct Deposited {
    pub agent_id: [u8; 16],
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultOpened {
    pub agent_id: [u8; 16],
    /// None for a house agent.
    pub owner: Option<Pubkey>,
}

#[event]
pub struct SettlerChanged {
    pub previous: Pubkey,
    pub settler: Pubkey,
}

#[event]
pub struct RentPaid {
    pub rental_id: [u8; 16],
    pub renter: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ChipRateChanged {
    pub previous: u64,
    pub chip_rate: u64,
    /// Rescaled with the rate, so it still means the same number of chips.
    pub max_settlement: u64,
}

#[event]
pub struct RentChanged {
    pub previous: u64,
    pub rent: u64,
}

#[event]
pub struct MaxSettlementChanged {
    pub previous: u64,
    pub max_settlement: u64,
}

#[event]
pub struct Settled {
    pub match_id: [u8; 16],
    pub from_agent: [u8; 16],
    pub to_agent: [u8; 16],
    pub amount: u64,
}

#[error_code]
pub enum OxudeError {
    #[msg("Only the configured settler can do this")]
    NotSettler,
    #[msg("Only the configured admin can do this")]
    NotAdmin,
    #[msg("The new settler must differ from the current settler and the admin, and cannot be the default key")]
    InvalidSettler,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Settlement exceeds the per-match limit")]
    OverLimit,
    #[msg("A match cannot settle an agent against itself")]
    SameAgent,
    #[msg("The paying vault cannot cover this settlement")]
    InsufficientVault,
    #[msg("Limit must be greater than zero")]
    InvalidLimit,
    #[msg("Only the agent's recorded owner can withdraw")]
    NotOwner,
    #[msg("Withdrawals go only to the owner's own token account")]
    NotOwnersAccount,
    #[msg("A deposit comes only from the depositor's own token account")]
    NotDepositorsAccount,
    #[msg("The rent paid is not the price the config carries")]
    WrongRent,
    #[msg("Rent is paid only from the renter's own token account")]
    NotRentersAccount,
    #[msg("The stake token does not have the expected number of decimals")]
    WrongStakeDecimals,
    #[msg("A chip limit does not fit in base units at this rate")]
    RateOverflow,
    #[msg("One chip cannot cost more than the ceiling on tokens per chip")]
    RateCeiling,
    #[msg("The chip rate cannot move by more than half in one step")]
    RateMoveTooBig,
    #[msg("The chip rate has not stood long enough to move again")]
    RateTooSoon,
    #[msg("The vault doesn't match the ledger: a settlement is still in flight")]
    LedgerMismatch,
    #[msg("A withdrawal must leave the vault empty or with at least the minimum stake")]
    Unplayable,
    #[msg("The agent id isn't the hash of this owner and salt")]
    AgentIdMismatch,
    #[msg("This vault has paid out all it can in this window")]
    OutflowLimit,
    #[msg("The stake token still has a mint authority: its supply is not fixed")]
    MintableStakeToken,
    #[msg("This exit's window has not passed yet")]
    ExitLocked,
    #[msg("This exit has already been claimed")]
    ExitAlreadyClaimed,
    #[msg("A claimed exit stays on chain a while, so the ledger can catch up before the record goes")]
    ExitEvidenceNeeded,
    #[msg("The exit window cannot be shorter than the program's floor")]
    ExitWindowTooShort,
    #[msg("The exit window cannot be more than halved in one step")]
    ExitWindowShrinkTooFast,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_window_grows_freely_and_shrinks_by_halves() {
        // Growing: always allowed, however far.
        assert!(window_shrink_ok(4_500, 9_000));
        assert!(window_shrink_ok(4_500, u64::MAX));
        // Exactly half is the edge, and it is allowed.
        assert!(window_shrink_ok(4_500, 2_250));
        assert!(!window_shrink_ok(4_500, 2_249));
        // Thirty minutes to the floor is nine steps, not one.
        let mut slots = 4_500u64;
        let mut steps = 0;
        while slots > MIN_EXIT_WINDOW_SLOTS {
            slots = (slots / 2).max(MIN_EXIT_WINDOW_SLOTS);
            steps += 1;
        }
        assert_eq!(steps, 9);
    }

    #[test]
    fn an_exit_pays_what_was_asked_when_the_vault_still_covers_it() {
        // 100 asked of 900 held, minimum 10: an ordinary partial exit.
        assert_eq!(exit_payout(100, 900, 10), 100);
        // Asking for everything.
        assert_eq!(exit_payout(900, 900, 10), 900);
    }

    #[test]
    fn an_exit_takes_less_rather_than_failing_when_the_window_took_some() {
        // Asked for 900, but a settlement landed while it waited and the vault
        // is down to 600. The claim takes 600. This is the window working, not
        // a failure, and it must not read as one.
        assert_eq!(exit_payout(900, 600, 10), 600);
        assert_eq!(exit_payout(900, 0, 10), 0);
    }

    #[test]
    fn an_exit_takes_the_lot_rather_than_leaving_dust() {
        // 895 of 900 would leave 5, under the minimum of 10. Rounds up to the
        // whole vault: the alternative is refusing, and an exit nobody
        // co-signs cannot afford to refuse on arithmetic the owner can't see.
        assert_eq!(exit_payout(895, 900, 10), 900);
        // Exactly the minimum left is fine, and is left.
        assert_eq!(exit_payout(890, 900, 10), 890);
        // One under is not.
        assert_eq!(exit_payout(891, 900, 10), 900);
    }

    #[test]
    fn an_exit_never_pays_more_than_the_vault_holds() {
        for asked in [0u64, 1, 50, 900, u64::MAX] {
            for held in [0u64, 1, 9, 10, 900] {
                assert!(exit_payout(asked, held, 10) <= held, "asked {asked} held {held}");
            }
        }
    }

    #[test]
    fn charge_stays_within_the_cap_and_resets_with_the_window() {
        assert_eq!(charge(0, 0, 100, 60, 120), Some((0, 60)));
        assert_eq!(charge(0, 60, 200, 60, 120), Some((0, 120)));
        assert_eq!(charge(0, 120, 300, 1, 120), None);
        // Still inside the window, one slot before it ends.
        assert_eq!(charge(0, 120, WINDOW_SLOTS - 1, 1, 120), None);
        // The window has run its course: a fresh one starts at this slot.
        assert_eq!(charge(0, 120, WINDOW_SLOTS, 60, 120), Some((WINDOW_SLOTS, 60)));
        // One charge can never exceed the cap on its own.
        assert_eq!(charge(0, 0, 5_000, 121, 120), None);
        assert_eq!(charge(0, u64::MAX, 1, 1, u64::MAX), None);
    }

    /// One chip at the rate devnet is fixed to: one whole token, six decimals.
    const CHIP: u64 = 1_000_000;

    #[test]
    fn the_outflow_cap_is_a_quarter_of_the_vault_with_a_floor() {
        let floor = OUTFLOW_FLOOR_CHIPS * CHIP;
        // Small vaults get the floor: a quarter of them is less than it.
        assert_eq!(outflow_cap(0, CHIP), floor);
        assert_eq!(outflow_cap(MIN_STAKE_CHIPS * CHIP, CHIP), floor);
        assert_eq!(outflow_cap(480 * CHIP, CHIP), floor);
        // The floor and the quarter meet at four times the floor.
        assert_eq!(outflow_cap(4 * floor, CHIP), floor);
        assert_eq!(outflow_cap(4 * floor + 4, CHIP), floor + 1);
        // Above that it is proportional: a vault of 900 chips pays out 225.
        assert_eq!(outflow_cap(900 * CHIP, CHIP), 225 * CHIP);
        // No overflow at the top of the range, and none in the floor either.
        assert_eq!(outflow_cap(u64::MAX, CHIP), u64::MAX / 4);
        assert_eq!(outflow_cap(0, u64::MAX), u64::MAX);
    }

    #[test]
    fn chip_limits_convert_at_the_rate_and_refuse_to_wrap() {
        assert_eq!(in_base_units(60, CHIP).unwrap(), 60_000_000);
        assert_eq!(in_base_units(MAX_SETTLEMENT_CEILING_CHIPS, CHIP).unwrap(), 900_000_000);
        assert_eq!(in_base_units(MIN_STAKE_CHIPS, CHIP).unwrap(), 10_000_000);
        // A rate that would make a limit wrap is an error, never a small number.
        assert!(in_base_units(MAX_SETTLEMENT_CEILING_CHIPS, u64::MAX).is_err());
    }

    #[test]
    fn a_rate_may_move_by_half_either_way_and_no_further() {
        // Exactly half and exactly half again as much are both allowed.
        assert!(rate_within_band(1_000, 500));
        assert!(rate_within_band(1_000, 1_500));
        assert!(rate_within_band(1_000, 1_000));
        // A hair outside either edge is not.
        assert!(!rate_within_band(1_000, 499));
        assert!(!rate_within_band(1_000, 1_501));
        // Zero is never a rate, and nothing wraps at the top of the range.
        assert!(!rate_within_band(1_000, 0));
        assert!(!rate_within_band(u64::MAX, u64::MAX));
    }

    #[test]
    fn a_rate_that_has_moved_must_stand_for_six_days_of_slots() {
        // Never moved: the first change need not wait.
        assert!(rate_interval_passed(0, 0));
        assert!(rate_interval_passed(0, 1));
        // Moved: not before the interval is out, and not a slot early.
        assert!(!rate_interval_passed(100, 100));
        assert!(!rate_interval_passed(100, 100 + MIN_RATE_INTERVAL_SLOTS - 1));
        assert!(rate_interval_passed(100, 100 + MIN_RATE_INTERVAL_SLOTS));
        // Six days of slots is inside a seven-day season.
        assert!(MIN_RATE_INTERVAL_SLOTS < 7 * 24 * 60 * 60 * 1_000 / 400);
        // Nothing wraps at the top of the range: the interval saturates rather
        // than rolling over into letting a change through early.
        assert!(!rate_interval_passed(u64::MAX, u64::MAX - 1));
        assert!(!rate_interval_passed(u64::MAX - MIN_RATE_INTERVAL_SLOTS + 1, 0));
    }

    #[test]
    fn an_agent_id_is_bound_to_its_owner_and_salt() {
        let owner = Pubkey::new_unique();
        let salt = [7u8; 16];
        let id = agent_id_for(&owner, &salt);
        assert_eq!(id, agent_id_for(&owner, &salt));
        assert_ne!(id, agent_id_for(&Pubkey::new_unique(), &salt));
        assert_ne!(id, agent_id_for(&owner, &[8u8; 16]));
        assert_ne!(id, agent_id_for(&Pubkey::default(), &salt));
    }
}
