import { PublicKey } from "@solana/web3.js";
import { deposit as officialDeposit } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/deposit";
import { depositWithMinSharesOut as officialDepositWithMinSharesOut } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/depositWithMinSharesOut";
import { withdraw as officialWithdraw } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdraw";
import { withdrawFromAvailable as officialWithdrawFromAvailable } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdrawFromAvailable";
import { address as kitAddress } from "@solana/kit";

import {
  createNeutralMapper,
  type NeutralInstructionInput,
  type NeutralMapperEnvironment,
  type NeutralMappingContext,
} from "../src/core";
import { getIntegrationAuthority, getVaultPda } from "../src/pda";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const BN = require("bn.js");

const KVAULT_PROGRAM = new PublicKey(
  "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
);
const KLEND_PROGRAM = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111",
);
const KVAULT_EVENT_AUTHORITY = new PublicKey(
  "24tHwQyJJ9akVXxnvkekGfAoeUJXXS7mE6kQNioNySsK",
);
const KVAULT_GLOBAL_CONFIG = new PublicKey(
  "BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX",
);
const EXT_KAMINO_PROGRAM = new PublicKey(
  "G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde",
);
const STAGING_EXT_KAMINO_PROGRAM = new PublicKey(
  "gstgKa2Gq9wf5hM3DFWx1TvUrGYzDYszyFGq3XBY9Uq",
);
const glamState = new PublicKey("F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp");
const glamSigner = new PublicKey(
  "8M5XgZWZWxGLDvJgXrv4b8ZFQT5BT8qjN5hPvVm4Cyqg",
);
const feePayer = PublicKey.unique();

function address(publicKey: PublicKey): never {
  return publicKey.toBase58() as never;
}

function signer(publicKey: PublicKey): never {
  return { address: publicKey.toBase58() } as never;
}

function deriveAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

const environment: NeutralMapperEnvironment = {
  normalizeAddress(value: string): string {
    return kitAddress(value);
  },
  async deriveAssociatedTokenAddress(input): Promise<string> {
    return deriveAta(
      new PublicKey(input.ownerAddress),
      new PublicKey(input.mintAddress),
      new PublicKey(input.tokenProgramAddress),
    ).toBase58();
  },
};
const mapper = createNeutralMapper(environment);

function context(staging = false): NeutralMappingContext {
  const proxy = staging ? STAGING_EXT_KAMINO_PROGRAM : EXT_KAMINO_PROGRAM;
  return {
    glamStateAddress: glamState.toBase58(),
    glamVaultAddress: getVaultPda(glamState, staging).toBase58(),
    glamSignerAddress: glamSigner.toBase58(),
    integrationAuthorityByProxyProgram: {
      [proxy.toBase58()]: getIntegrationAuthority(proxy).toBase58(),
    },
  };
}

function reserveMarketPairs(count: number): never[] {
  return [
    ...Array.from({ length: count }, () => ({
      address: PublicKey.unique().toBase58(),
      role: 1,
    })),
    ...Array.from({ length: count }, () => ({
      address: PublicKey.unique().toBase58(),
      role: 0,
    })),
  ] as never[];
}

function createAtaInstruction(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): NeutralInstructionInput {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM.toBase58(),
    accounts: [
      { address: feePayer.toBase58(), role: 3 },
      { address: deriveAta(owner, mint, tokenProgram).toBase58(), role: 1 },
      { address: owner.toBase58(), role: 0 },
      { address: mint.toBase58(), role: 0 },
      { address: SYSTEM_PROGRAM.toBase58(), role: 0 },
      { address: tokenProgram.toBase58(), role: 0 },
    ],
    data: Uint8Array.of(1),
  };
}

function depositFixture(staging = false) {
  const owner = getVaultPda(glamState, staging);
  const sharesMint = PublicKey.unique();
  const sharesAta = deriveAta(owner, sharesMint, TOKEN_PROGRAM);
  const accounts = {
    user: signer(owner),
    vaultState: address(PublicKey.unique()),
    tokenVault: address(PublicKey.unique()),
    tokenMint: address(PublicKey.unique()),
    baseVaultAuthority: address(PublicKey.unique()),
    sharesMint: address(sharesMint),
    userTokenAta: address(PublicKey.unique()),
    userSharesAta: address(sharesAta),
    klendProgram: address(KLEND_PROGRAM),
    tokenProgram: address(TOKEN_PROGRAM),
    sharesTokenProgram: address(TOKEN_PROGRAM),
    eventAuthority: address(KVAULT_EVENT_AUTHORITY),
    program: address(KVAULT_PROGRAM),
  };
  return {
    owner,
    sharesMint,
    ata: createAtaInstruction(owner, sharesMint, TOKEN_PROGRAM),
    instruction: officialDeposit(
      { maxAmount: new BN(123_456) },
      accounts as never,
      reserveMarketPairs(2),
      address(KVAULT_PROGRAM),
    ),
    minSharesInstruction: officialDepositWithMinSharesOut(
      { maxAmount: new BN(123_456), minSharesOut: new BN(120_000) },
      accounts as never,
      reserveMarketPairs(2),
      address(KVAULT_PROGRAM),
    ),
  };
}

function withdrawFixture(
  staging = false,
  tokenProgram = TOKEN_PROGRAM,
  shared?: ReturnType<typeof withdrawAccounts>,
) {
  const owner = getVaultPda(glamState, staging);
  const accounts = shared ?? withdrawAccounts(owner, tokenProgram);
  const mint = new PublicKey(accounts.withdrawFromAvailable.tokenMint);
  return {
    owner,
    mint,
    accounts,
    ata: createAtaInstruction(owner, mint, tokenProgram),
    instruction: officialWithdraw(
      { sharesAmount: new BN(42_000) },
      accounts as never,
      reserveMarketPairs(2),
      address(KVAULT_PROGRAM),
    ),
    availableInstruction: officialWithdrawFromAvailable(
      { sharesAmount: new BN(42_000) },
      accounts.withdrawFromAvailable as never,
      reserveMarketPairs(2),
      address(KVAULT_PROGRAM),
    ),
  };
}

function withdrawAccounts(owner: PublicKey, tokenProgram = TOKEN_PROGRAM) {
  const vaultState = PublicKey.unique();
  const tokenMint = PublicKey.unique();
  return {
    withdrawFromAvailable: {
      user: signer(owner),
      vaultState: address(vaultState),
      globalConfig: address(KVAULT_GLOBAL_CONFIG),
      tokenVault: address(PublicKey.unique()),
      baseVaultAuthority: address(PublicKey.unique()),
      userTokenAta: address(deriveAta(owner, tokenMint, tokenProgram)),
      tokenMint: address(tokenMint),
      userSharesAta: address(PublicKey.unique()),
      sharesMint: address(PublicKey.unique()),
      tokenProgram: address(tokenProgram),
      sharesTokenProgram: address(TOKEN_PROGRAM),
      klendProgram: address(KLEND_PROGRAM),
      eventAuthority: address(KVAULT_EVENT_AUTHORITY),
      program: address(KVAULT_PROGRAM),
    },
    withdrawFromReserveAccounts: {
      vaultState: address(vaultState),
      reserve: address(PublicKey.unique()),
      ctokenVault: address(PublicKey.unique()),
      lendingMarket: address(PublicKey.unique()),
      lendingMarketAuthority: address(PublicKey.unique()),
      reserveLiquiditySupply: address(PublicKey.unique()),
      reserveCollateralMint: address(PublicKey.unique()),
      reserveCollateralTokenProgram: address(TOKEN_PROGRAM),
      instructionSysvarAccount: address(INSTRUCTIONS_SYSVAR),
    },
    eventAuthority: address(KVAULT_EVENT_AUTHORITY),
    program: address(KVAULT_PROGRAM),
  };
}

function mutate(
  instruction: NeutralInstructionInput,
  accountIndex: number,
  patch: Partial<{ address: string; role: 0 | 1 | 2 | 3 }>,
): NeutralInstructionInput {
  const accounts = (instruction.accounts ?? []).map((account) => ({
    ...account,
  }));
  accounts[accountIndex] = { ...accounts[accountIndex], ...patch };
  return { ...instruction, accounts };
}

describe("complete KVault operation mapping", () => {
  it("maps the exact official classic deposit sequence atomically", async () => {
    const fixture = depositFixture();
    const result = await mapper.mapKaminoKvaultOperationNeutral(
      {
        operation: "deposit",
        instructions: [fixture.ata, fixture.instruction],
        ataPayerAddress: feePayer.toBase58(),
      },
      context(),
    );

    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    expect(result.instructions.map(({ kind }) => kind)).toEqual([
      "safePassthrough",
      "mapped",
    ]);
    expect(result.instructions[0]).toMatchObject({
      sourceInstructionName: "CreateIdempotent",
      instruction: fixture.ata,
    });
    expect(result.instructions[1]).toMatchObject({
      sourceInstructionName: "deposit",
      destinationInstructionName: "vaults_deposit",
    });
  });

  it("maps one ATA followed by multiple official classic withdraws", async () => {
    const first = withdrawFixture();
    const second = withdrawFixture(false, TOKEN_PROGRAM, first.accounts);
    const result = await mapper.mapKaminoKvaultOperationNeutral(
      {
        operation: "withdraw",
        instructions: [first.ata, first.instruction, second.instruction],
        ataPayerAddress: feePayer.toBase58(),
      },
      context(),
    );

    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    expect(result.instructions.map(({ kind }) => kind)).toEqual([
      "safePassthrough",
      "mapped",
      "mapped",
    ]);
  });

  it("supports a Token-2022 destination ATA through the same exact binding", async () => {
    const fixture = withdrawFixture(false, TOKEN_2022_PROGRAM);
    const result = await mapper.mapKaminoKvaultOperationNeutral(
      {
        operation: "withdraw",
        instructions: [fixture.ata, fixture.instruction],
        ataPayerAddress: feePayer.toBase58(),
      },
      context(),
    );

    expect(result.kind).toBe("mappedOperation");
  });

  it("selects staging only when both the source owner and option are staging", async () => {
    const fixture = depositFixture(true);
    const result = await mapper.mapKaminoKvaultOperationNeutral(
      {
        operation: "deposit",
        instructions: [fixture.ata, fixture.instruction],
        ataPayerAddress: feePayer.toBase58(),
      },
      context(true),
      { staging: true },
    );

    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    expect(result.instructions[1].instruction.programAddress).toBe(
      STAGING_EXT_KAMINO_PROGRAM.toBase58(),
    );
  });

  it("fails closed when a staging operation is evaluated under production", async () => {
    const fixture = depositFixture(true);
    await expect(
      mapper.mapKaminoKvaultOperationNeutral(
        {
          operation: "deposit",
          instructions: [fixture.ata, fixture.instruction],
          ataPayerAddress: feePayer.toBase58(),
        },
        context(true),
      ),
    ).resolves.toMatchObject({ kind: "unsupported", instructionIndex: 1 });
  });

  it("keeps the ATA unsupported outside a complete operation", () => {
    const fixture = depositFixture();
    expect(mapper.mapInstructionNeutral(fixture.ata, context())).toMatchObject({
      kind: "unsupported",
      reason: "unsupported-program",
    });
  });

  it("requires an independent ATA derivation binding", async () => {
    const fixture = depositFixture();
    const noDerivation = createNeutralMapper({
      normalizeAddress: environment.normalizeAddress,
    });
    await expect(
      noDerivation.mapKaminoKvaultOperationNeutral(
        {
          operation: "deposit",
          instructions: [fixture.ata, fixture.instruction],
          ataPayerAddress: feePayer.toBase58(),
        },
        context(),
      ),
    ).resolves.toMatchObject({
      kind: "unsupported",
      reason: "operation-binding",
    });
  });

  it.each([
    ["payer", 0, { address: PublicKey.unique().toBase58() }],
    ["ATA", 1, { address: PublicKey.unique().toBase58() }],
    ["owner", 2, { address: PublicKey.unique().toBase58() }],
    ["mint", 3, { address: PublicKey.unique().toBase58() }],
    ["system program", 4, { address: PublicKey.unique().toBase58() }],
    ["token program", 5, { address: PublicKey.unique().toBase58() }],
    ["role", 0, { role: 2 as const }],
  ])("rejects a changed ATA %s", async (_label, index, patch) => {
    const fixture = depositFixture();
    const result = await mapper.mapKaminoKvaultOperationNeutral(
      {
        operation: "deposit",
        instructions: [mutate(fixture.ata, index, patch), fixture.instruction],
        ataPayerAddress: feePayer.toBase58(),
      },
      context(),
    );
    expect(result.kind).toBe("unsupported");
  });

  it("rejects changed ATA data, extra accounts, and wrong ordering", async () => {
    const fixture = depositFixture();
    const changedData = { ...fixture.ata, data: Uint8Array.of(0) };
    const extraAccount = {
      ...fixture.ata,
      accounts: [
        ...(fixture.ata.accounts ?? []),
        { address: PublicKey.unique().toBase58(), role: 0 as const },
      ],
    };

    for (const instructions of [
      [changedData, fixture.instruction],
      [extraAccount, fixture.instruction],
      [fixture.instruction, fixture.ata],
    ]) {
      const result = await mapper.mapKaminoKvaultOperationNeutral(
        {
          operation: "deposit",
          instructions,
          ataPayerAddress: feePayer.toBase58(),
        },
        context(),
      );
      expect(result.kind).toBe("unsupported");
    }
  });

  it("rejects unsupported KVault variants without returning partial output", async () => {
    const deposit = depositFixture();
    const withdraw = withdrawFixture();
    const results = await Promise.all([
      mapper.mapKaminoKvaultOperationNeutral(
        {
          operation: "deposit",
          instructions: [deposit.ata, deposit.minSharesInstruction],
          ataPayerAddress: feePayer.toBase58(),
        },
        context(),
      ),
      mapper.mapKaminoKvaultOperationNeutral(
        {
          operation: "withdraw",
          instructions: [withdraw.ata, withdraw.availableInstruction],
          ataPayerAddress: feePayer.toBase58(),
        },
        context(),
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        kind: "unsupported",
        instructionIndex: 1,
      }),
      expect.objectContaining({
        kind: "unsupported",
        instructionIndex: 1,
      }),
    ]);
  });

  it("rejects wrapped-SOL sources even when helper instructions were stripped", async () => {
    const deposit = depositFixture();
    const withdraw = withdrawFixture();
    const wrappedDeposit = mutate(deposit.instruction, 3, {
      address: "So11111111111111111111111111111111111111112",
    });
    const wrappedWithdraw = mutate(withdraw.instruction, 6, {
      address: "So11111111111111111111111111111111111111112",
    });

    const results = await Promise.all([
      mapper.mapKaminoKvaultOperationNeutral(
        {
          operation: "deposit",
          instructions: [deposit.ata, wrappedDeposit],
          ataPayerAddress: feePayer.toBase58(),
        },
        context(),
      ),
      mapper.mapKaminoKvaultOperationNeutral(
        {
          operation: "withdraw",
          instructions: [withdraw.ata, wrappedWithdraw],
          ataPayerAddress: feePayer.toBase58(),
        },
        context(),
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        kind: "unsupported",
        reason: "operation-binding",
        instructionIndex: 1,
      }),
      expect.objectContaining({
        kind: "unsupported",
        reason: "operation-binding",
        instructionIndex: 1,
      }),
    ]);
  });

  it("snapshots all mutable inputs before awaiting ATA derivation", async () => {
    const fixture = depositFixture();
    let releaseDerivation: (() => void) | undefined;
    const derivationGate = new Promise<void>((resolve) => {
      releaseDerivation = resolve;
    });
    const delayedMapper = createNeutralMapper({
      normalizeAddress: environment.normalizeAddress,
      async deriveAssociatedTokenAddress(input): Promise<string> {
        await derivationGate;
        return environment.deriveAssociatedTokenAddress!(input);
      },
    });
    const mutableInput = {
      operation: "deposit",
      instructions: [fixture.ata, fixture.instruction],
      ataPayerAddress: feePayer.toBase58(),
    } as const;
    const mutableContext = context() as {
      glamStateAddress: string;
      glamVaultAddress: string;
      glamSignerAddress: string;
      integrationAuthorityByProxyProgram: Record<string, string>;
    };
    const pending = delayedMapper.mapKaminoKvaultOperationNeutral(
      mutableInput,
      mutableContext,
    );

    (mutableInput as { operation: string }).operation = "withdraw";
    (mutableInput as { ataPayerAddress: string }).ataPayerAddress =
      PublicKey.unique().toBase58();
    (mutableInput.instructions as unknown as NeutralInstructionInput[])[0] = {
      programAddress: PublicKey.unique().toBase58(),
      accounts: [],
      data: new Uint8Array(),
    };
    mutableContext.glamVaultAddress = PublicKey.unique().toBase58();
    releaseDerivation!();

    const result = await pending;
    expect(result).toMatchObject({
      kind: "mappedOperation",
      operation: "deposit",
    });
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    expect(result.instructions.map(({ kind }) => kind)).toEqual([
      "safePassthrough",
      "mapped",
    ]);
    expect(result.instructions[0].instruction.accounts[0]).toEqual({
      address: feePayer.toBase58(),
      role: 3,
    });
  });

  it("rejects inconsistent destination bindings across multiple withdraws", async () => {
    const first = withdrawFixture();
    const second = withdrawFixture();
    const result = await mapper.mapKaminoKvaultOperationNeutral(
      {
        operation: "withdraw",
        instructions: [first.ata, first.instruction, second.instruction],
        ataPayerAddress: feePayer.toBase58(),
      },
      context(),
    );

    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "operation-binding",
      instructionIndex: 2,
    });
  });
});
