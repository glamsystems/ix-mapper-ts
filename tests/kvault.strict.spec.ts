import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { deposit as officialDeposit } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/deposit";
import { depositWithMinSharesOut as officialDepositWithMinSharesOut } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/depositWithMinSharesOut";
import { withdraw as officialWithdraw } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdraw";
import { withdrawFromAvailable as officialWithdrawFromAvailable } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdrawFromAvailable";

import {
  mapInstruction,
  mapInstructions,
  normalizeInstruction,
  type MapInstructionResult,
  type UnsupportedInstructionReason,
} from "../src/index";
import {
  GLAM_PROGRAM_ID,
  getIntegrationAuthority,
  getVaultPda,
} from "../src/pda";

// Kamino's generated KVault builders encode u64 values with bn.js. It is an
// implementation dependency of the exact SDK version pinned for these golden
// fixtures; the mapper does not take a runtime dependency on it.
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

const glamState = new PublicKey(
  "F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp",
);
const glamSigner = new PublicKey(
  "8M5XgZWZWxGLDvJgXrv4b8ZFQT5BT8qjN5hPvVm4Cyqg",
);

function address(publicKey: PublicKey): never {
  return publicKey.toBase58() as never;
}

function signer(publicKey: PublicKey): never {
  return { address: publicKey.toBase58() } as never;
}

function reserveMarketPairs(count: number): never[] {
  const reserves = Array.from({ length: count }, () => ({
    address: PublicKey.unique().toBase58(),
    role: 1,
  }));
  const markets = Array.from({ length: count }, () => ({
    address: PublicKey.unique().toBase58(),
    role: 0,
  }));
  return [...reserves, ...markets] as never[];
}

function depositAccounts(vaultPda: PublicKey, tokenProgram = TOKEN_PROGRAM) {
  return {
    user: signer(vaultPda),
    vaultState: address(PublicKey.unique()),
    tokenVault: address(PublicKey.unique()),
    tokenMint: address(PublicKey.unique()),
    baseVaultAuthority: address(PublicKey.unique()),
    sharesMint: address(PublicKey.unique()),
    userTokenAta: address(PublicKey.unique()),
    userSharesAta: address(PublicKey.unique()),
    klendProgram: address(KLEND_PROGRAM),
    tokenProgram: address(tokenProgram),
    sharesTokenProgram: address(TOKEN_PROGRAM),
    eventAuthority: address(KVAULT_EVENT_AUTHORITY),
    program: address(KVAULT_PROGRAM),
  };
}

function buildDeposit(
  pairCount = 2,
  options: { staging?: boolean; tokenProgram?: PublicKey } = {},
): TransactionInstruction {
  return normalizeInstruction(buildOfficialDeposit(pairCount, options));
}

function buildOfficialDeposit(
  pairCount = 2,
  options: { staging?: boolean; tokenProgram?: PublicKey } = {},
) {
  const vaultPda = getVaultPda(glamState, options.staging ?? false);
  return officialDeposit(
    { maxAmount: new BN(123_456) },
    depositAccounts(vaultPda, options.tokenProgram) as never,
    reserveMarketPairs(pairCount),
    address(KVAULT_PROGRAM),
  );
}

function withdrawAccounts(vaultPda: PublicKey, tokenProgram = TOKEN_PROGRAM) {
  const vaultState = PublicKey.unique();
  return {
    withdrawFromAvailable: {
      user: signer(vaultPda),
      vaultState: address(vaultState),
      globalConfig: address(KVAULT_GLOBAL_CONFIG),
      tokenVault: address(PublicKey.unique()),
      baseVaultAuthority: address(PublicKey.unique()),
      userTokenAta: address(PublicKey.unique()),
      tokenMint: address(PublicKey.unique()),
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

function buildWithdraw(
  pairCount = 2,
  options: { staging?: boolean; tokenProgram?: PublicKey } = {},
): TransactionInstruction {
  return normalizeInstruction(buildOfficialWithdraw(pairCount, options));
}

function buildOfficialWithdraw(
  pairCount = 2,
  options: { staging?: boolean; tokenProgram?: PublicKey } = {},
) {
  const vaultPda = getVaultPda(glamState, options.staging ?? false);
  return officialWithdraw(
    { sharesAmount: new BN(42_000) },
    withdrawAccounts(vaultPda, options.tokenProgram) as never,
    reserveMarketPairs(pairCount),
    address(KVAULT_PROGRAM),
  );
}

function cloneWith(
  instruction: TransactionInstruction,
  options: {
    data?: Uint8Array;
    keys?: AccountMeta[];
  },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: instruction.programId,
    keys: options.keys ?? instruction.keys.map((meta) => ({ ...meta })),
    data: Buffer.from(options.data ?? instruction.data),
  });
}

function mutateAccount(
  instruction: TransactionInstruction,
  index: number,
  patch: Partial<AccountMeta>,
): TransactionInstruction {
  const keys = instruction.keys.map((meta) => ({ ...meta }));
  keys[index] = { ...keys[index], ...patch };
  return cloneWith(instruction, { keys });
}

function expectMapped(result: MapInstructionResult): TransactionInstruction {
  expect(result.kind).toBe("mapped");
  if (result.kind !== "mapped") {
    throw new Error(`${result.reason}: ${result.message}`);
  }
  return result.instruction;
}

function expectUnsupported(
  result: MapInstructionResult,
  reason: UnsupportedInstructionReason,
): void {
  expect(result.kind).toBe("unsupported");
  if (result.kind !== "unsupported") {
    throw new Error(`Expected ${reason}, received ${result.kind}`);
  }
  expect(result.reason).toBe(reason);
}

function meta(
  pubkey: PublicKey,
  isWritable: boolean,
  isSigner = false,
): AccountMeta {
  return { pubkey, isWritable, isSigner };
}

function expectedMappedKeys(
  source: TransactionInstruction,
  sourceProgramIndex: number,
): AccountMeta[] {
  const sourceFixedWithoutUser = source.keys
    .slice(1, sourceProgramIndex + 1)
    .map((account) => ({ ...account }));
  return [
    meta(glamState, true),
    meta(getVaultPda(glamState), true),
    meta(glamSigner, true, true),
    meta(getIntegrationAuthority(EXT_KAMINO_PROGRAM), false),
    meta(KVAULT_PROGRAM, false),
    meta(GLAM_PROGRAM_ID, false),
    meta(SystemProgram.programId, false),
    ...sourceFixedWithoutUser,
    ...source.keys.slice(sourceProgramIndex + 1).map((account) => ({
      ...account,
    })),
  ];
}

describe("schema-v2 KVault mappings", () => {
  it("maps an official SDK deposit and preserves its audited payload and tail", () => {
    const officialSource = buildOfficialDeposit(2);
    const source = normalizeInstruction(officialSource);
    const result = mapInstruction(officialSource, glamState, glamSigner);
    const mapped = expectMapped(result);

    expect(result).toMatchObject({
      kind: "mapped",
      sourceInstructionName: "deposit",
      destinationInstructionName: "vaults_deposit",
    });
    expect(mapped.programId).toEqual(EXT_KAMINO_PROGRAM);
    expect([...mapped.data.subarray(0, 8)]).toEqual([
      124, 173, 191, 223, 48, 26, 84, 84,
    ]);
    expect(mapped.data.subarray(8)).toEqual(source.data.subarray(8));
    expect(mapped.keys).toHaveLength(23);
    expect(mapped.keys).toEqual(expectedMappedKeys(source, 12));
  });

  it("accepts the official SDK deposit layout for a Token-2022 vault", () => {
    const source = buildDeposit(0, { tokenProgram: TOKEN_2022_PROGRAM });
    expectMapped(mapInstruction(source, glamState, glamSigner));
  });

  it("maps an official SDK withdraw with all 25 fixed accounts", () => {
    const officialSource = buildOfficialWithdraw(2);
    const source = normalizeInstruction(officialSource);
    const result = mapInstruction(officialSource, glamState, glamSigner);
    const mapped = expectMapped(result);

    expect(result).toMatchObject({
      kind: "mapped",
      sourceInstructionName: "withdraw",
      destinationInstructionName: "vaults_withdraw",
    });
    expect(mapped.programId).toEqual(EXT_KAMINO_PROGRAM);
    expect(mapped.keys).toHaveLength(35);
    // Source account 24 is now part of the audited fixed layout, not an
    // unrestricted first remaining account.
    expect(mapped.keys[30]).toEqual(source.keys[24]);
    expect(mapped.keys).toEqual(expectedMappedKeys(source, 24));
  });

  it("selects the staging proxy only for a staging-vault source layout", () => {
    const stagingSource = buildDeposit(1, { staging: true });
    const mapped = expectMapped(
      mapInstruction(stagingSource, glamState, glamSigner, { staging: true }),
    );
    expect(mapped.programId).toEqual(STAGING_EXT_KAMINO_PROGRAM);

    expectUnsupported(
      mapInstruction(stagingSource, glamState, glamSigner),
      "account-address",
    );
  });

  it("preserves ordered results in a batch without dropping unsupported instructions", () => {
    const unsupported = cloneWith(buildDeposit(), {
      data: Buffer.from([74, 127, 128, 80, 4, 221, 193, 91]),
    });
    const results = mapInstructions(
      [buildOfficialDeposit(), unsupported, buildOfficialWithdraw()],
      glamState,
      glamSigner,
    );

    expect(results.map(({ kind }) => kind)).toEqual([
      "mapped",
      "unsupported",
      "mapped",
    ]);
    expectUnsupported(results[1], "unsupported-instruction");
  });

  it("fails closed for depositWithMinSharesOut from the official SDK", () => {
    const vaultPda = getVaultPda(glamState);
    const source = officialDepositWithMinSharesOut(
      { maxAmount: new BN(100), minSharesOut: new BN(99) },
      depositAccounts(vaultPda) as never,
      reserveMarketPairs(1),
      address(KVAULT_PROGRAM),
    );

    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "unsupported-instruction",
    );
  });

  it("fails closed for withdrawFromAvailable from the official SDK", () => {
    const vaultPda = getVaultPda(glamState);
    const accounts = withdrawAccounts(vaultPda).withdrawFromAvailable;
    const source = officialWithdrawFromAvailable(
      { sharesAmount: new BN(100) },
      accounts as never,
      [],
      address(KVAULT_PROGRAM),
    );

    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "unsupported-instruction",
    );
  });

  it("requires the exact classic deposit and withdraw data lengths", () => {
    const deposit = buildDeposit();
    const withdraw = buildWithdraw();

    expectUnsupported(
      mapInstruction(
        cloneWith(deposit, {
          data: Buffer.concat([deposit.data, Buffer.from([0])]),
        }),
        glamState,
        glamSigner,
      ),
      "invalid-data",
    );
    expectUnsupported(
      mapInstruction(
        cloneWith(withdraw, { data: withdraw.data.subarray(0, 15) }),
        glamState,
        glamSigner,
      ),
      "invalid-data",
    );
  });

  it("fails closed for malformed Solana Kit account roles", () => {
    const source = buildOfficialDeposit(0);
    const accounts = [...(source.accounts ?? [])];
    accounts[0] = { ...accounts[0], role: 4 as never };

    expectUnsupported(
      mapInstruction({ ...source, accounts }, glamState, glamSigner),
      "invalid-instruction",
    );
  });

  it("normalizes structurally readonly Solana Kit byte data", () => {
    const source = buildOfficialDeposit(0);
    expectMapped(
      mapInstruction(
        { ...source, data: Array.from(source.data ?? []) },
        glamState,
        glamSigner,
      ),
    );
  });

  it("requires the GLAM vault PDA as the native KVault user", () => {
    const source = mutateAccount(buildDeposit(), 0, {
      pubkey: PublicKey.unique(),
    });
    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "account-address",
    );
  });

  it("rejects elevated or reduced fixed-account privileges", () => {
    const elevated = mutateAccount(buildDeposit(), 3, { isWritable: true });
    const reduced = mutateAccount(buildWithdraw(), 15, { isWritable: false });

    expectUnsupported(
      mapInstruction(elevated, glamState, glamSigner),
      "account-meta",
    );
    expectUnsupported(
      mapInstruction(reduced, glamState, glamSigner),
      "account-meta",
    );
  });

  it("rejects duplicate fixed keys with conflicting effective privileges", () => {
    const source = buildDeposit(0);
    source.keys[3] = {
      ...source.keys[3],
      pubkey: source.keys[5].pubkey,
    };

    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "account-meta",
    );
  });

  it("rejects duplicate remaining keys across different privilege segments", () => {
    const source = buildDeposit(1);
    source.keys[14] = {
      ...source.keys[14],
      pubkey: source.keys[13].pubkey,
    };

    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "account-meta",
    );
  });

  it("rejects conflicting duplicate privileges introduced at the destination", () => {
    const source = buildDeposit(0);

    expectUnsupported(
      mapInstruction(source, glamState, source.keys[3].pubkey),
      "destination-invariant",
    );
  });

  it.each([
    ["KLend program", 8],
    ["base token program", 9],
    ["shares token program", 10],
    ["event authority", 11],
    ["KVault program", 12],
  ])("rejects a deposit with a changed %s account", (_label, index) => {
    const source = mutateAccount(buildDeposit(), index, {
      pubkey: PublicKey.unique(),
    });
    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "account-address",
    );
  });

  it.each([
    ["global config", 2],
    ["KLend program", 11],
    ["first event authority", 12],
    ["first KVault program", 13],
    ["reserve collateral token program", 21],
    ["instructions sysvar", 22],
    ["second event authority", 23],
    ["second KVault program", 24],
  ])("rejects a withdraw with a changed %s account", (_label, index) => {
    const source = mutateAccount(buildWithdraw(), index, {
      pubkey: PublicKey.unique(),
    });
    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "account-address",
    );
  });

  it("requires both withdraw vault-state accounts to be identical", () => {
    const source = mutateAccount(buildWithdraw(), 14, {
      pubkey: PublicKey.unique(),
    });
    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "account-address",
    );
  });

  it("requires all 13 deposit and 25 withdraw fixed accounts", () => {
    const deposit = buildDeposit(0);
    const withdraw = buildWithdraw(0);

    expectUnsupported(
      mapInstruction(
        cloneWith(deposit, { keys: deposit.keys.slice(0, 12) }),
        glamState,
        glamSigner,
      ),
      "account-count",
    );
    expectUnsupported(
      mapInstruction(
        cloneWith(withdraw, { keys: withdraw.keys.slice(0, 24) }),
        glamState,
        glamSigner,
      ),
      "account-count",
    );
  });

  it("rejects an odd remaining-account suffix", () => {
    const source = buildDeposit(1);
    source.keys.pop();
    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "remaining-accounts",
    );
  });

  it("rejects remaining accounts outside their reserve/market privilege segments", () => {
    const source = buildWithdraw(2);
    source.keys[25] = { ...source.keys[25], isWritable: false };
    source.keys[27] = { ...source.keys[27], isWritable: true };

    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "remaining-accounts",
    );
  });

  it("rejects any signer in the remaining reserve/market segments", () => {
    const source = buildDeposit(1);
    source.keys[13] = { ...source.keys[13], isSigner: true };
    expectUnsupported(
      mapInstruction(source, glamState, glamSigner),
      "remaining-accounts",
    );
  });

  it("accepts at most the KVault allocation limit of 25 reserve/market pairs", () => {
    expectMapped(mapInstruction(buildDeposit(25), glamState, glamSigner));
    expectUnsupported(
      mapInstruction(buildDeposit(26), glamState, glamSigner),
      "remaining-accounts",
    );
  });
});
