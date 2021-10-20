use access_control::*;
use account::*;
use anchor_lang::prelude::*;
use anchor_spl::token;
use context::*;
use error::*;

mod access_control;
mod account;
mod context;
mod error;

// The program address.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// # Introduction
///
/// The governance registry is an "addin" to the SPL governance program that
/// allows one to both vote with many different ypes of tokens for voting and to
/// scale voting power as a linear function of time locked--subject to some
/// maximum upper bound.
///
/// The flow for voting with this program is as follows:
///
/// - Create a SPL governance realm.
/// - Create a governance registry account.
/// - Add exchange rates for any tokens one wants to deposit. For example,
///   if one wants to vote with tokens A and B, where token B has twice the
///   voting power of token A, then the exchange rate of B would be 2 and the
///   exchange rate of A would be 1.
/// - Create a voter account.
/// - Deposit tokens into this program, with an optional lockup period.
/// - Vote.
///
/// Upon voting with SPL governance, a client is expected to call
/// `decay_voting_power` to get an up to date measurement of a given `Voter`'s
/// voting power for the given slot. If this is not done, then the transaction
/// will fail (since the SPL governance program will require the measurement
/// to be active for the current slot).
///
/// # Interacting with SPL Governance
///
/// This program does not directly interact with SPL governance via CPI.
/// Instead, it simply writes a `VoterWeightRecord` account with a well defined
/// format, which is then used by SPL governance as the voting power measurement
/// for a given user.
///
/// # Max Vote Weight
///
/// Given that one can use multiple tokens to vote, the max vote weight needs
/// to be a function of the total supply of all tokens, converted into a common
/// currency. For example, if you have Token A and Token B, where 1 Token B =
/// 10 Token A, then the `max_vote_weight` should be `supply(A) + supply(B)*10`
/// where both are converted into common decimals. Then, when calculating the
/// weight of an individual voter, one can convert B into A via the given
/// exchange rate, which must be fixed.
///
/// Note that the above also implies that the `max_vote_weight` must fit into
/// a u64.
#[program]
pub mod governance_registry {
    use super::*;

    /// Creates a new voting registrar. There can only be a single regsitrar
    /// per governance realm.
    pub fn create_registrar(
        ctx: Context<CreateRegistrar>,
        warmup_secs: i64,
        registrar_bump: u8,
        voting_mint_bump: u8,
        _voting_mint_decimals: u8,
    ) -> Result<()> {
        let registrar = &mut ctx.accounts.registrar.load_init()?;
        registrar.bump = registrar_bump;
        registrar.voting_mint_bump = voting_mint_bump;
        registrar.realm = ctx.accounts.realm.key();
        registrar.voting_mint = ctx.accounts.voting_mint.key();
        registrar.authority = ctx.accounts.authority.key();
        registrar.warmup_secs = warmup_secs;

        Ok(())
    }

    /// Creates a new exchange rate for a given mint. This allows a voter to
    /// deposit the mint in exchange for vTokens. There can only be a single
    /// exchange rate per mint.
    ///
    /// WARNING: This can be freely called when any of the rates are empty.
    ///          This should be called immediately upon creation of a Registrar.
    #[access_control(rate_is_empty(&ctx, idx))]
    pub fn create_exchange_rate(
        ctx: Context<CreateExchangeRate>,
        idx: u16,
        er: ExchangeRateEntry,
    ) -> Result<()> {
        require!(er.rate > 0, InvalidRate);

        let registrar = &mut ctx.accounts.registrar.load_mut()?;
        registrar.rates[idx as usize] = er;
        Ok(())
    }

    /// Creates a new voter account. There can only be a single voter per
    /// user wallet.
    pub fn create_voter(ctx: Context<CreateVoter>, voter_bump: u8) -> Result<()> {
        let voter = &mut ctx.accounts.voter.load_init()?;
        voter.voter_bump = voter_bump;
        voter.authority = ctx.accounts.authority.key();
        voter.registrar = ctx.accounts.registrar.key();

        Ok(())
    }

    /// Creates a new deposit entry and updates it by transferring in tokens.
    pub fn create_deposit(
        ctx: Context<CreateDeposit>,
        kind: LockupKind,
        amount: u64,
        days: i32,
    ) -> Result<()> {
        // Creates the new deposit.
        let deposit_id = {
            // Load accounts.
            let registrar = &ctx.accounts.deposit.registrar.load()?;
            let voter = &mut ctx.accounts.deposit.voter.load_mut()?;

            // Set the lockup start timestamp, delayed by the warmup period.
            let start_ts = Clock::get()?.unix_timestamp + registrar.warmup_secs;

            // Get the exchange rate entry associated with this deposit.
            let er_idx = registrar
                .rates
                .iter()
                .position(|r| r.mint == ctx.accounts.deposit.deposit_mint.key())
                .ok_or(ErrorCode::ExchangeRateEntryNotFound)?;

            // Get and set up the first free deposit entry.
            let free_entry_idx = voter
                .deposits
                .iter()
                .position(|d_entry| !d_entry.is_used)
                .ok_or(ErrorCode::DepositEntryFull)?;
            let d_entry = &mut voter.deposits[free_entry_idx];
            d_entry.is_used = true;
            d_entry.rate_idx = free_entry_idx as u8;
            d_entry.rate_idx = er_idx as u8;
            d_entry.amount_withdrawn = 0;
            d_entry.lockup = Lockup {
                kind,
                start_ts,
                end_ts: start_ts
                    .checked_add(i64::from(days).checked_mul(SECS_PER_DAY).unwrap())
                    .unwrap(),
                padding: [0u8; 16],
            };

            free_entry_idx as u8
        };

        // Updates the entry by transferring in tokens.
        let update_ctx = Context::new(ctx.program_id, &mut ctx.accounts.deposit, &[]);
        update_deposit(update_ctx, deposit_id, amount)?;

        Ok(())
    }

    /// Updates a deposit entry by depositing tokens into the registrar in
    /// exchange for *frozen* voting tokens. These tokens are not used for
    /// anything other than displaying the amount in wallets.
    pub fn update_deposit(ctx: Context<UpdateDeposit>, id: u8, amount: u64) -> Result<()> {
        let registrar = &ctx.accounts.registrar.load()?;
        let voter = &mut ctx.accounts.voter.load_mut()?;

        // Get the exchange rate entry associated with this deposit.
        let er_idx = registrar
            .rates
            .iter()
            .position(|r| r.mint == ctx.accounts.deposit_mint.key())
            .ok_or(ErrorCode::ExchangeRateEntryNotFound)?;
        let er_entry = registrar.rates[er_idx];

        // Calculate the amount of voting tokens to mint at the specified
        // exchange rate.
        let amount_scaled = er_entry.rate * amount;

        require!(voter.deposits.len() > id as usize, InvalidDepositId);
        let d_entry = &mut voter.deposits[id as usize];
        d_entry.amount_deposited += amount;
        d_entry.amount_scaled += amount_scaled;

        // Deposit tokens into the registrar.
        token::transfer(ctx.accounts.transfer_ctx(), amount)?;

        // Thaw the account if it's frozen, so that we can mint.
        if ctx.accounts.voting_token.is_frozen() {
            token::thaw_account(
                ctx.accounts
                    .thaw_ctx()
                    .with_signer(&[&[registrar.realm.as_ref(), &[registrar.bump]]]),
            )?;
        }

        // Mint vote tokens to the depositor.
        token::mint_to(
            ctx.accounts
                .mint_to_ctx()
                .with_signer(&[&[registrar.realm.as_ref(), &[registrar.bump]]]),
            amount_scaled,
        )?;

        // Freeze the vote tokens; they are just used for UIs + accounting.
        token::freeze_account(
            ctx.accounts
                .freeze_ctx()
                .with_signer(&[&[registrar.realm.as_ref(), &[registrar.bump]]]),
        )?;

        Ok(())
    }

    /// Withdraws tokens from a deposit entry, if they are unlocked according
    /// to a vesting schedule.
    ///
    /// `amount` is in units of the native currency being withdrawn.
    pub fn withdraw(ctx: Context<Withdraw>, deposit_id: u8, amount: u64) -> Result<()> {
        let registrar = &ctx.accounts.registrar.load()?;
        let voter = &mut ctx.accounts.voter.load_mut()?;
        require!(voter.deposits.len() > deposit_id.into(), InvalidDepositId);

        // Update the deposit bookkeeping.
        let deposit_entry = &mut voter.deposits[deposit_id as usize];
        require!(deposit_entry.is_used, InvalidDepositId);
        require!(deposit_entry.vested()? >= amount, InsufficientVestedTokens);
        require!(
            deposit_entry.amount_left() >= amount,
            InsufficientVestedTokens
        );
        deposit_entry.amount_deposited -= amount;

        // Get the exchange rate for the token being withdrawn.
        let er_idx = registrar
            .rates
            .iter()
            .position(|r| r.mint == ctx.accounts.withdraw_mint.key())
            .ok_or(ErrorCode::ExchangeRateEntryNotFound)?;
        let er_entry = registrar.rates[er_idx];

        let amount_scaled = er_entry.rate * amount;

        // Transfer the tokens to withdraw.
        token::transfer(
            ctx.accounts
                .transfer_ctx()
                .with_signer(&[&[registrar.realm.as_ref(), &[registrar.bump]]]),
            amount,
        )?;

        // Unfreeze the voting mint.
        token::thaw_account(
            ctx.accounts
                .thaw_ctx()
                .with_signer(&[&[registrar.realm.as_ref(), &[registrar.bump]]]),
        )?;

        // Burn the voting tokens.
        token::burn(ctx.accounts.burn_ctx(), amount_scaled)?;

        Ok(())
    }

    /// Resets a lockup to start at the current slot timestamp and to last for
    /// `days`, which must be longer than the number of days left on the lockup.
    pub fn reset_lockup(ctx: Context<UpdateSchedule>, deposit_id: u8, days: i64) -> Result<()> {
        let voter = &mut ctx.accounts.voter.load_mut()?;
        require!(voter.deposits.len() > deposit_id as usize, InvalidDepositId);

        let d = &mut voter.deposits[deposit_id as usize];
        require!(d.is_used, InvalidDepositId);

        // The lockup period can only be increased.
        require!(days as u64 > d.lockup.days_left()?, InvalidDays);

        let start_ts = Clock::get()?.unix_timestamp;
        let end_ts = start_ts
            .checked_add(days.checked_mul(SECS_PER_DAY).unwrap())
            .unwrap();

        d.lockup.start_ts = start_ts;
        d.lockup.end_ts = end_ts;

        Ok(())
    }

    /// Calculates the lockup-scaled, time-decayed voting power for the given
    /// voter and writes it into a `VoteWeightRecord` account to be used by
    /// the SPL governance program.
    ///
    /// This "revise" instruction should be called in the same transaction,
    /// immediately before voting.
    pub fn decay_voting_power(ctx: Context<DecayVotingPower>) -> Result<()> {
        let voter = ctx.accounts.voter.load()?;
        let record = &mut ctx.accounts.vote_weight_record;
        record.voter_weight = voter.weight()?;
        record.voter_weight_expiry = Some(Clock::get()?.slot);
        Ok(())
    }

    /// Closes the voter account, allowing one to retrieve rent exemption SOL.
    pub fn close_voter(ctx: Context<CloseVoter>) -> Result<()> {
        require!(ctx.accounts.voting_token.amount > 0, VotingTokenNonZero);
        Ok(())
    }
}
