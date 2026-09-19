//! Oxude settlement on Solana.
//!
//! The off-chain ledger is authoritative: it decides every movement, after the
//! server has validated the match against both balances. This program records
//! those decisions on chain and holds the currency, and it independently limits
//! what the server's key can do:
//!
//! - only the configured settler key can open vaults or settle;
//! - a single settlement can never move more than `max_settlement`;
//! - each match settles at most once, because its record is a PDA seeded by the
//!   match id and cannot be created twice;
//! - vaults are PDAs whose authority is the config PDA, so no private key -
//!   the server's included - can move vault funds except through `settle`
//!   and `withdraw`;
//! - a withdrawal needs the agent's owner to sign, checked against the owner
//!   recorded on chain (set once, never changed), and the settler to co-sign;
//!   it goes only to the owner's own token account, must leave the vault at
//!   exactly the balance the ledger says (so an unsettled match makes it
//!   refuse), must leave it empty or playable, and happens at most once per
//!   withdrawal id.
//!
//! No model is involved in anything here. An agent's decision table produces a
//! match result off chain; the server validates it; only then does the settler
//! sign a settlement.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("EKJHJ8jsuXQ9hzy4qPXMsAHDagA38C1pkDWoz3un8kir");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const OWNER_SEED: &[u8] = b"owner";
pub const WITHDRAWAL_SEED: &[u8] = b"withdrawal";
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

    /// Opens an agent's vault and funds it with its starting balance. Called
    /// when an agent is rented.
    pub fn open_vault(ctx: Context<OpenVault>, agent_id: [u8; 16], amount: u64) -> Result<()> {
        require!(amount > 0, OxudeError::ZeroAmount);
        let bump = ctx.accounts.config.bump;
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        emit!(VaultOpened { agent_id, amount });
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
        record.slot = Clock::get()?.slot;
        record.bump = ctx.bumps.settlement;
        emit!(Settled { match_id, from_agent, to_agent, amount });
        Ok(())
    }

    /// Records who owns an agent. Settler-only, and only once per agent: the
    /// record is a PDA that cannot be created twice, so an owner once set can
    /// never be changed - not by the server, not by anyone.
    pub fn register_owner(ctx: Context<RegisterOwner>, agent_id: [u8; 16], owner: Pubkey) -> Result<()> {
        let record = &mut ctx.accounts.agent_owner;
        record.agent_id = agent_id;
        record.owner = owner;
        record.bump = ctx.bumps.agent_owner;
        emit!(OwnerRegistered { agent_id, owner });
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
#[instruction(agent_id: [u8; 16])]
pub struct RegisterOwner<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = settler @ OxudeError::NotSettler)]
    pub config: Account<'info, Config>,
    /// The agent must have a vault: an owner for nothing is meaningless.
    #[account(seeds = [VAULT_SEED, agent_id.as_ref()], bump, token::mint = config.mint)]
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
pub struct OwnerRegistered {
    pub agent_id: [u8; 16],
    pub owner: Pubkey,
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
    pub amount: u64,
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
}
