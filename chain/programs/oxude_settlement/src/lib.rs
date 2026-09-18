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
//!   the server's included - can move vault funds except through `settle`.
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
}
