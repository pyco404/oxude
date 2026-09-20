//! Oxude settlement on Solana.
//!
//! The off-chain ledger is authoritative: it decides every movement, after the
//! server has validated the match against both balances. This program records
//! those decisions on chain and holds the currency, and it independently limits
//! what the server's key can do:
//!
//! - only the configured settler key can open vaults or settle, and only the
//!   admin can point the config at a different one;
//! - a single settlement can never move more than `max_settlement`, which only
//!   the admin key can change and never above `MAX_SEED`; and no
//!   vault can pay out more than `outflow_cap` of its own balance through
//!   settlements in one window of `WINDOW_SLOTS`; a vault opens with at most
//!   `MAX_SEED`, and all vaults opened in one window mint at most `MINT_CAP`
//!   between them - so a stolen settler key drains and mints slowly enough to
//!   be stopped;
//! - an agent id is bound to its owner: it is the hash of the owner's key and
//!   a salt, checked as the vault opens, and the owner is recorded in that same
//!   instruction. No key - the settler's included - can record anyone else as
//!   the owner of that agent;
//! - each match settles at most once, because its record is a PDA seeded by the
//!   match id and cannot be created twice;
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
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("EKJHJ8jsuXQ9hzy4qPXMsAHDagA38C1pkDWoz3un8kir");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const OWNER_SEED: &[u8] = b"owner";
pub const WITHDRAWAL_SEED: &[u8] = b"withdrawal";
pub const OUTFLOW_SEED: &[u8] = b"outflow";
pub const MINT_BUDGET_SEED: &[u8] = b"mint_budget";
/// Mixed into every agent id, so an id can't be confused with any other hash.
pub const AGENT_ID_DOMAIN: &[u8] = b"oxude-agent-v1";
/// A rate-limit window: about ten minutes of slots.
pub const WINDOW_SLOTS: u64 = 1_500;
/// The least one vault can pay out through settlements in one window. A small
/// vault is allowed this much even though a quarter of it is less.
pub const OUTFLOW_FLOOR: u64 = 120;
/// The most a vault can be opened with: the starting balance.
pub const MAX_SEED: u64 = 900;
/// The most all vaults opened in one window can mint between them.
pub const MINT_CAP: u64 = 20 * MAX_SEED;
/// The smallest stake a match can have. A vault left with less than this
/// could never play again, so a withdrawal must leave nothing or at least this.
pub const MIN_STAKE: u64 = 10;

#[program]
pub mod oxude_settlement {
    use super::*;

    /// One-time setup: the config, and the game currency's mint (0 decimals,
    /// minted only by the config PDA).
    pub fn initialize(ctx: Context<Initialize>, settler: Pubkey, max_settlement: u64) -> Result<()> {
        require!(max_settlement > 0, OxudeError::InvalidLimit);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.settler = settler;
        config.mint = ctx.accounts.mint.key();
        config.max_settlement = max_settlement;
        config.bump = ctx.bumps.config;
        config.mint_bump = ctx.bumps.mint;
        Ok(())
    }

    /// Raises or lowers the most a single settlement can move. The admin
    /// recorded at initialize is the only key that can call it - not the
    /// settler, whose reach this value is there to limit in the first place.
    /// It exists so a band with bigger stakes can be priced in without another
    /// program upgrade, and it is bounded by `MAX_SEED` so that a stolen admin
    /// key cannot turn the per-settlement guard off altogether.
    pub fn set_max_settlement(ctx: Context<SetMaxSettlement>, max_settlement: u64) -> Result<()> {
        require!(max_settlement > 0, OxudeError::InvalidLimit);
        require!(max_settlement <= MAX_SEED, OxudeError::InvalidLimit);
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

    /// Opens an agent's vault and funds it with its starting balance. Called
    /// when an agent is rented.
    pub fn open_vault(mut ctx: Context<OpenVault>, agent_id: [u8; 16], salt: [u8; 16], amount: u64) -> Result<()> {
        require!(agent_id == agent_id_for(&Pubkey::default(), &salt), OxudeError::AgentIdMismatch);
        let accounts = &mut ctx.accounts;
        fund_vault(&accounts.config, &mut accounts.mint_budget, ctx.bumps.mint_budget, &accounts.mint, &accounts.vault, &accounts.token_program, amount)?;
        emit!(VaultOpened { agent_id, owner: None, amount });
        Ok(())
    }

    /// Opens a player's agent's vault and records its owner, together. The
    /// agent id must be the hash of that owner's key and the salt, so this is
    /// the only owner the agent can ever have: whoever sends it, the settler
    /// included, can't record another, and the record can't be created twice.
    pub fn open_owned_vault(
        mut ctx: Context<OpenOwnedVault>,
        agent_id: [u8; 16],
        salt: [u8; 16],
        owner: Pubkey,
        amount: u64,
    ) -> Result<()> {
        require!(owner != Pubkey::default(), OxudeError::AgentIdMismatch);
        require!(agent_id == agent_id_for(&owner, &salt), OxudeError::AgentIdMismatch);
        let accounts = &mut ctx.accounts;
        fund_vault(&accounts.config, &mut accounts.mint_budget, ctx.bumps.mint_budget, &accounts.mint, &accounts.vault, &accounts.token_program, amount)?;
        let record = &mut accounts.agent_owner;
        record.agent_id = agent_id;
        record.owner = owner;
        record.bump = ctx.bumps.agent_owner;
        emit!(VaultOpened { agent_id, owner: Some(owner), amount });
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
        let cap = outflow_cap(ctx.accounts.from_vault.amount);
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
        require!(remaining == 0 || remaining >= MIN_STAKE, OxudeError::Unplayable);

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
/// of what it holds, but never less than `OUTFLOW_FLOOR`. Proportional so that
/// a large vault is not held to a small one's limit, and so that the seed can
/// grow without loosening the cap on every vault below it.
///
/// `settle` reads this from the balance before each payment leaves, so the cap
/// falls as the vault pays and what it has already spent chases a falling
/// target. A window therefore closes at a fifth of the balance it opened with,
/// not a quarter: spending stops once `spent > (start - spent) / 4`, which is
/// `spent > start / 5`. A vault seeded at `MAX_SEED` pays out 180 in a window
/// and keeps 720. That is deliberate - the declining cap is the conservative
/// reading, and it only bites when one agent is being farmed by a crowd, which
/// the ledger throttles first. Above the floor, no snapshot is stored.
pub fn outflow_cap(vault: u64) -> u64 {
    OUTFLOW_FLOOR.max(vault / 4)
}

/// A fixed-window budget: `(window_start, spent)` after charging `amount` at
/// `slot`, or None if it would go over `cap`. A window that has run its course
/// starts again from this slot.
pub fn charge(window_start: u64, spent: u64, slot: u64, amount: u64, cap: u64) -> Option<(u64, u64)> {
    let (start, spent) = if slot >= window_start.saturating_add(WINDOW_SLOTS) { (slot, 0) } else { (window_start, spent) };
    let spent = spent.checked_add(amount)?;
    (spent <= cap).then_some((start, spent))
}

/// Mints a new vault's starting balance, within the per-vault and per-window limits.
fn fund_vault<'info>(
    config: &Account<'info, Config>,
    budget: &mut Account<'info, MintBudget>,
    budget_bump: u8,
    mint: &Account<'info, Mint>,
    vault: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, OxudeError::ZeroAmount);
    require!(amount <= MAX_SEED, OxudeError::OverLimit);
    budget.bump = budget_bump;
    (budget.window_start, budget.spent) =
        charge(budget.window_start, budget.spent, Clock::get()?.slot, amount, MINT_CAP).ok_or(OxudeError::MintLimit)?;
    let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo { mint: mint.to_account_info(), to: vault.to_account_info(), authority: config.to_account_info() },
            signer,
        ),
        amount,
    )
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
    pub bump: u8,
    pub mint_bump: u8,
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

/// One for the program: how much new vaults have minted in the current window.
#[account]
#[derive(InitSpace)]
pub struct MintBudget {
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
    #[account(init, payer = admin, mint::decimals = 0, mint::authority = config, seeds = [MINT_SEED], bump)]
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(agent_id: [u8; 16])]
pub struct OpenVault<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = settler,
        space = 8 + MintBudget::INIT_SPACE,
        seeds = [MINT_BUDGET_SEED],
        bump
    )]
    pub mint_budget: Account<'info, MintBudget>,
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
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = settler,
        space = 8 + MintBudget::INIT_SPACE,
        seeds = [MINT_BUDGET_SEED],
        bump
    )]
    pub mint_budget: Account<'info, MintBudget>,
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

#[event]
pub struct Withdrawn {
    pub withdrawal_id: [u8; 16],
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct VaultOpened {
    pub agent_id: [u8; 16],
    /// None for a house agent.
    pub owner: Option<Pubkey>,
    pub amount: u64,
}

#[event]
pub struct SettlerChanged {
    pub previous: Pubkey,
    pub settler: Pubkey,
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
    #[msg("The vault doesn't match the ledger: a settlement is still in flight")]
    LedgerMismatch,
    #[msg("A withdrawal must leave the vault empty or with at least the minimum stake")]
    Unplayable,
    #[msg("The agent id isn't the hash of this owner and salt")]
    AgentIdMismatch,
    #[msg("This vault has paid out all it can in this window")]
    OutflowLimit,
    #[msg("New vaults have minted all they can in this window")]
    MintLimit,
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn the_outflow_cap_is_a_quarter_of_the_vault_with_a_floor() {
        // Small vaults get the floor: a quarter of them is less than it.
        assert_eq!(outflow_cap(0), OUTFLOW_FLOOR);
        assert_eq!(outflow_cap(MIN_STAKE), OUTFLOW_FLOOR);
        assert_eq!(outflow_cap(480), OUTFLOW_FLOOR);
        // The floor and the quarter meet at four times the floor.
        assert_eq!(outflow_cap(4 * OUTFLOW_FLOOR), OUTFLOW_FLOOR);
        assert_eq!(outflow_cap(4 * OUTFLOW_FLOOR + 4), OUTFLOW_FLOOR + 1);
        // Above that it is proportional: a full seed can pay out a quarter.
        assert_eq!(outflow_cap(MAX_SEED), MAX_SEED / 4);
        assert_eq!(outflow_cap(MAX_SEED), 225);
        // No overflow at the top of the range.
        assert_eq!(outflow_cap(u64::MAX), u64::MAX / 4);
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
