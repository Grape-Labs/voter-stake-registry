import * as assert from "assert";
import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { createMintAndVault, sleep } from "@project-serum/common";
import BN from "bn.js";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { VoterStakeRegistry } from "../target/types/voter_stake_registry";

const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

describe("voting-rights", () => {
  anchor.setProvider(anchor.Provider.env());

  const program = anchor.workspace
    .VoterStakeRegistry as Program<VoterStakeRegistry>;

  // Initialized variables shared across tests.
  const governanceProgramId = new PublicKey(
    "GovernanceProgram11111111111111111111111111"
  );
  const realm = Keypair.generate().publicKey;
  const votingMintDecimals = 6;
  const tokenProgram = TOKEN_PROGRAM_ID;
  const associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ID;
  const rent = SYSVAR_RENT_PUBKEY;
  const systemProgram = SystemProgram.programId;

  // Uninitialized variables shared across tests.
  let registrar: PublicKey,
    votingMintA: PublicKey,
    votingMintB: PublicKey,
    voter: PublicKey,
    voterWeightRecord: PublicKey,
    tokenOwnerRecord: PublicKey,
    votingToken: PublicKey,
    exchangeVaultA: PublicKey,
    exchangeVaultB: PublicKey;
  let registrarBump: number,
    votingMintBumpA: number,
    votingMintBumpB: number,
    voterBump: number,
    voterWeightRecordBump: number;
  let mintA: PublicKey,
    mintB: PublicKey,
    godA: PublicKey,
    godB: PublicKey,
    realmCommunityMint: PublicKey;
  let tokenAClient: Token,
    tokenBClient: Token,
    votingTokenClientA: Token,
    votingTokenClientB: Token;

  it("Creates tokens and mints", async () => {
    const [_mintA, _godA] = await createMintAndVault(
      program.provider,
      new BN("1000000000000000000"),
      undefined,
      6
    );
    const [_mintB, _godB] = await createMintAndVault(
      program.provider,
      new BN("1000000000000000000"),
      undefined,
      0
    );

    mintA = _mintA;
    mintB = _mintB;
    godA = _godA;
    godB = _godB;
    realmCommunityMint = mintA;
  });

  it("Creates PDAs", async () => {
    const [_registrar, _registrarBump] = await PublicKey.findProgramAddress(
      [realm.toBuffer()],
      program.programId
    );
    const [_votingMintA, _votingMintBumpA] = await PublicKey.findProgramAddress(
      [_registrar.toBuffer(), mintA.toBuffer()],
      program.programId
    );
    const [_votingMintB, _votingMintBumpB] = await PublicKey.findProgramAddress(
      [_registrar.toBuffer(), mintB.toBuffer()],
      program.programId
    );
    const [_voter, _voterBump] = await PublicKey.findProgramAddress(
      [_registrar.toBuffer(), program.provider.wallet.publicKey.toBuffer()],
      program.programId
    );
    const [_voterWeightRecord, _voterWeightRecordBump] =
      await PublicKey.findProgramAddress(
        [
          anchor.utils.bytes.utf8.encode("voter-weight-record"),
          _registrar.toBuffer(),
          program.provider.wallet.publicKey.toBuffer(),
        ],
        program.programId
      );
    votingToken = await Token.getAssociatedTokenAddress(
      associatedTokenProgram,
      tokenProgram,
      _votingMintA,
      program.provider.wallet.publicKey
    );
    exchangeVaultA = await Token.getAssociatedTokenAddress(
      associatedTokenProgram,
      tokenProgram,
      mintA,
      _registrar,
      true
    );
    exchangeVaultB = await Token.getAssociatedTokenAddress(
      associatedTokenProgram,
      tokenProgram,
      mintB,
      _registrar,
      true
    );

    registrar = _registrar;
    votingMintA = _votingMintA;
    votingMintB = _votingMintB;
    voter = _voter;

    registrarBump = _registrarBump;
    votingMintBumpA = _votingMintBumpA;
    votingMintBumpB = _votingMintBumpB;
    voterBump = _voterBump;
    voterWeightRecord = _voterWeightRecord;
    voterWeightRecordBump = _voterWeightRecordBump;
    // TODO: Need to make a governance program and create a real record to be able to withdraw
    tokenOwnerRecord = new PublicKey(
      "TokenownerRecord111111111111111111111111111"
    );
  });

  it("Creates token clients", async () => {
    tokenAClient = new Token(
      program.provider.connection,
      mintA,
      TOKEN_PROGRAM_ID,
      // @ts-ignore
      program.provider.wallet.payer
    );
    tokenBClient = new Token(
      program.provider.connection,
      mintB,
      TOKEN_PROGRAM_ID,
      // @ts-ignore
      program.provider.wallet.payer
    );
    votingTokenClientA = new Token(
      program.provider.connection,
      votingMintA,
      TOKEN_PROGRAM_ID,
      // @ts-ignore
      program.provider.wallet.payer
    );
    votingTokenClientB = new Token(
      program.provider.connection,
      votingMintB,
      TOKEN_PROGRAM_ID,
      // @ts-ignore
      program.provider.wallet.payer
    );
  });

  it("Initializes a registrar", async () => {
    await program.rpc.createRegistrar(6, registrarBump, {
      accounts: {
        registrar,
        governanceProgramId,
        realm,
        realmGoverningTokenMint: realmCommunityMint,
        realmAuthority: program.provider.wallet.publicKey,
        payer: program.provider.wallet.publicKey,
        systemProgram,
        tokenProgram,
        rent,
      },
    });
  });

  it("Adds an exchange rate A", async () => {
    let rate = new BN(1);
    let decimals = 6;
    await program.rpc.createExchangeRate(0, mintA, rate, decimals, {
      accounts: {
        exchangeVault: exchangeVaultA,
        depositMint: mintA,
        votingMint: votingMintA,
        registrar,
        realmAuthority: program.provider.wallet.publicKey,
        payer: program.provider.wallet.publicKey,
        rent,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      },
    });
  });

  it("Adds an exchange rate B", async () => {
    let rate = new BN(1000000);
    let decimals = 0;
    await program.rpc.createExchangeRate(1, mintB, rate, decimals, {
      accounts: {
        exchangeVault: exchangeVaultB,
        depositMint: mintB,
        votingMint: votingMintB,
        registrar,
        realmAuthority: program.provider.wallet.publicKey,
        payer: program.provider.wallet.publicKey,
        rent,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
      },
    });
  });

  it("Initializes a voter", async () => {
    await program.rpc.createVoter(voterBump, voterWeightRecordBump, {
      accounts: {
        voter,
        voterWeightRecord,
        registrar,
        voterAuthority: program.provider.wallet.publicKey,
        payer: program.provider.wallet.publicKey,
        systemProgram,
        associatedTokenProgram,
        tokenProgram,
        rent,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      },
    });
  });

  it("Deposits cliff locked A tokens", async () => {
    const amount = new BN(10);
    const kind = { cliff: {} };
    const days = 1;
    await program.rpc.createDeposit(kind, amount, days, {
      accounts: {
        deposit: {
          voter,
          exchangeVault: exchangeVaultA,
          depositToken: godA,
          votingToken,
          voterAuthority: program.provider.wallet.publicKey,
          registrar,
          depositMint: mintA,
          votingMint: votingMintA,
          tokenProgram,
          systemProgram,
          associatedTokenProgram,
          rent,
        },
      },
    });

    const voterAccount = await program.account.voter.fetch(voter);
    const deposit = voterAccount.deposits[0];
    assert.ok(deposit.isUsed);
    assert.ok(deposit.amountDeposited.toNumber() === 10);
    assert.ok(deposit.rateIdx === 0);

    const vtAccount = await votingTokenClientA.getAccountInfo(votingToken);
    assert.ok(vtAccount.amount.toNumber() === 10);
  });

  it("Withdraws cliff locked A tokens", async () => {
    await sleep(1.1 * 10000);
    const depositId = 0;
    const amount = new BN(10);
    await program.rpc.withdraw(depositId, amount, {
      accounts: {
        registrar,
        voter,
        tokenOwnerRecord,
        exchangeVault: exchangeVaultA,
        withdrawMint: mintA,
        votingToken,
        votingMint: votingMintA,
        destination: godA,
        voterAuthority: program.provider.wallet.publicKey,
        tokenProgram,
      },
    });

    const voterAccount = await program.account.voter.fetch(voter);
    const deposit = voterAccount.deposits[0];
    assert.ok(deposit.isUsed);
    assert.ok(deposit.amountDeposited.toNumber() === 0);
    assert.ok(deposit.rateIdx === 0);

    const vtAccount = await votingTokenClientA.getAccountInfo(votingToken);
    assert.ok(vtAccount.amount.toNumber() === 0);
  });

  it("Deposits daily locked A tokens", async () => {
    const amount = new BN(10);
    const kind = { daily: {} };
    const days = 1;
    await program.rpc.createDeposit(kind, amount, days, {
      accounts: {
        deposit: {
          voter,
          exchangeVault: exchangeVaultA,
          depositToken: godA,
          votingToken,
          voterAuthority: program.provider.wallet.publicKey,
          registrar,
          depositMint: mintA,
          votingMint: votingMintA,
          tokenProgram,
          systemProgram,
          associatedTokenProgram,
          rent,
        },
      },
    });

    const voterAccount = await program.account.voter.fetch(voter);
    const deposit = voterAccount.deposits[1];
    assert.ok(deposit.isUsed);
    assert.ok(deposit.amountDeposited.toNumber() === 10);
    assert.ok(deposit.rateIdx === 0);
  });

  it("Withdraws daily locked A tokens", async () => {
    await sleep(1.1 * 10000);
    const depositId = 1;
    const amount = new BN(10);
    await program.rpc.withdraw(depositId, amount, {
      accounts: {
        registrar,
        voter,
        tokenOwnerRecord,
        exchangeVault: exchangeVaultA,
        withdrawMint: mintA,
        votingToken,
        votingMint: votingMintA,
        destination: godA,
        voterAuthority: program.provider.wallet.publicKey,
        tokenProgram,
      },
    });

    const voterAccount = await program.account.voter.fetch(voter);
    const deposit = voterAccount.deposits[0];
    assert.ok(deposit.isUsed);
    assert.ok(deposit.amountDeposited.toNumber() === 0);
    assert.ok(deposit.rateIdx === 0);

    const vtAccount = await votingTokenClientA.getAccountInfo(votingToken);
    assert.ok(vtAccount.amount.toNumber() === 0);
  });

  it("Deposits monthly locked A tokens", async () => {
    const amount = new BN(10);
    const kind = { monthly: {} };
    const months = 10;
    await program.rpc.createDeposit(kind, amount, months, {
      accounts: {
        deposit: {
          voter,
          exchangeVault: exchangeVaultA,
          depositToken: godA,
          votingToken,
          voterAuthority: program.provider.wallet.publicKey,
          registrar,
          depositMint: mintA,
          votingMint: votingMintA,
          tokenProgram,
          systemProgram,
          associatedTokenProgram,
          rent,
        },
      },
    });

    const voterAccount = await program.account.voter.fetch(voter);
    const deposit = voterAccount.deposits[2];
    assert.ok(deposit.isUsed);
    assert.ok(deposit.amountDeposited.toNumber() === 10);
    assert.ok(deposit.rateIdx === 0);
  });

  it("Fails withdrawing more than vested monthly locked A tokens", async () => {
    const depositId = 2;
    await sleep(1.5 * 10000);
    // too early to withdraw 2
    const amount = new BN(2);

    try {
      await program.rpc.withdraw(depositId, amount, {
        accounts: {
          registrar,
          voter,
          tokenOwnerRecord,
          exchangeVault: exchangeVaultA,
          withdrawMint: mintA,
          votingToken,
          votingMint: votingMintA,
          destination: godA,
          voterAuthority: program.provider.wallet.publicKey,
          tokenProgram,
        },
      });
      assert.ok(false);
    } catch (e) {
      assert.ok(e.message.replace(/ /g, "") === "307:");
    }
  });

  it("Withdraws monthly locked A tokens", async () => {
    const depositId = 2;
    const amount = new BN(1);
    await program.rpc.withdraw(depositId, amount, {
      accounts: {
        registrar,
        voter,
        tokenOwnerRecord,
        exchangeVault: exchangeVaultA,
        withdrawMint: mintA,
        votingToken,
        votingMint: votingMintA,
        destination: godA,
        voterAuthority: program.provider.wallet.publicKey,
        tokenProgram,
      },
    });

    const voterAccount = await program.account.voter.fetch(voter);
    const deposit = voterAccount.deposits[depositId];
    assert.ok(deposit.isUsed);
    assert.ok(deposit.amountDeposited.toNumber() === 9);
    assert.ok(deposit.rateIdx === 0);

    const vtAccount = await votingTokenClientA.getAccountInfo(votingToken);
    assert.ok(vtAccount.amount.toNumber() === 9);
  });

  it("Updates a vote weight record", async () => {
    await program.rpc.updateVoterWeightRecord({
      accounts: {
        registrar,
        voter,
        voterWeightRecord,
        systemProgram,
      },
    });
  });
});