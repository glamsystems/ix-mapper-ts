import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { deposit as officialDeposit } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/deposit";
import { withdraw as officialWithdraw } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdraw";
import { address as kitAddress } from "@solana/kit";

import {
  createNeutralMapper,
  type InstructionClassificationConfig,
  type NeutralInstruction,
  type NeutralMapInstructionResult,
  type NeutralMapperEnvironment,
  type NeutralMappingContext,
  type SolanaAccountRole,
  type StrictRemappingConfigs,
} from "../src/core";
import {
  mapInstruction,
  normalizeInstruction,
  type MapInstructionResult,
} from "../src/index";
import { getIntegrationAuthority, getVaultPda } from "../src/pda";
import {
  mapInstructionWithConfigs,
  validateInstructionClassificationConfig,
} from "../src/strict";

// Kamino's generated KVault builders encode u64 values with bn.js. This is an
// implementation dependency of the exact SDK version pinned by the mapper.
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
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const glamState = new PublicKey("F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp");
const glamSigner = new PublicKey(
  "8M5XgZWZWxGLDvJgXrv4b8ZFQT5BT8qjN5hPvVm4Cyqg",
);

const environment: NeutralMapperEnvironment = {
  normalizeAddress(value: string): string {
    return kitAddress(value);
  },
};
const neutralMapper = createNeutralMapper(environment);

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

function depositAccounts(vaultPda: PublicKey) {
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
    tokenProgram: address(TOKEN_PROGRAM),
    sharesTokenProgram: address(TOKEN_PROGRAM),
    eventAuthority: address(KVAULT_EVENT_AUTHORITY),
    program: address(KVAULT_PROGRAM),
  };
}

function buildOfficialDeposit(staging: boolean) {
  const vaultPda = getVaultPda(glamState, staging);
  return officialDeposit(
    { maxAmount: new BN(123_456) },
    depositAccounts(vaultPda) as never,
    reserveMarketPairs(2),
    address(KVAULT_PROGRAM),
  );
}

function withdrawAccounts(vaultPda: PublicKey) {
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
      tokenProgram: address(TOKEN_PROGRAM),
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

function buildOfficialWithdraw(staging: boolean) {
  const vaultPda = getVaultPda(glamState, staging);
  return officialWithdraw(
    { sharesAmount: new BN(42_000) },
    withdrawAccounts(vaultPda) as never,
    reserveMarketPairs(2),
    address(KVAULT_PROGRAM),
  );
}

function mappingContext(staging: boolean): NeutralMappingContext {
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

function expectNeutralMapped(
  result: NeutralMapInstructionResult,
): NeutralInstruction {
  expect(result.kind).toBe("mapped");
  if (result.kind !== "mapped") {
    throw new Error(`${result.reason}: ${result.message}`);
  }
  return result.instruction;
}

function expectLegacyMapped(
  result: MapInstructionResult,
): TransactionInstruction {
  expect(result.kind).toBe("mapped");
  if (result.kind !== "mapped") {
    throw new Error(`${result.reason}: ${result.message}`);
  }
  return result.instruction;
}

function expectLegacyEquivalent(
  neutral: NeutralInstruction,
  legacy: TransactionInstruction,
): void {
  expect(legacy.programId.toBase58()).toBe(neutral.programAddress);
  expect([...legacy.data]).toEqual([...neutral.data]);
  expect(
    legacy.keys.map(({ pubkey, isSigner, isWritable }) => ({
      address: pubkey.toBase58(),
      role: ((isWritable ? 1 : 0) | (isSigner ? 2 : 0)) as SolanaAccountRole,
    })),
  ).toEqual(neutral.accounts);
}

const operations = [
  { name: "deposit", build: buildOfficialDeposit },
  { name: "withdraw", build: buildOfficialWithdraw },
] as const;

describe("neutral mapper Kit compatibility", () => {
  it.each(operations)(
    "maps an official Kamino $name instruction directly without legacy normalization",
    ({ build }) => {
      const officialKitInstruction = build(false);

      const mapped = expectNeutralMapped(
        neutralMapper.mapInstructionNeutral(
          officialKitInstruction,
          mappingContext(false),
        ),
      );

      expect(mapped.programAddress).toBe(EXT_KAMINO_PROGRAM.toBase58());
    },
  );

  describe.each([
    { name: "production", staging: false },
    { name: "staging", staging: true },
  ])("$name", ({ staging }) => {
    it.each(operations)(
      "produces byte/account-equivalent neutral and legacy $name output",
      ({ build }) => {
        const officialKitInstruction = build(staging);
        const neutral = expectNeutralMapped(
          neutralMapper.mapInstructionNeutral(
            officialKitInstruction,
            mappingContext(staging),
            { staging },
          ),
        );
        const legacySource = normalizeInstruction(officialKitInstruction);
        const legacy = expectLegacyMapped(
          mapInstruction(legacySource, glamState, glamSigner, { staging }),
        );

        expectLegacyEquivalent(neutral, legacy);
      },
    );
  });
});

const passthroughContext: NeutralMappingContext = {
  glamStateAddress: glamState.toBase58(),
  glamVaultAddress: getVaultPda(glamState).toBase58(),
  glamSignerAddress: glamSigner.toBase58(),
  integrationAuthorityByProxyProgram: {},
};
const emptyMappings: StrictRemappingConfigs = {};
const exactPassthroughConfig = validateInstructionClassificationConfig(
  {
    schema_version: 1,
    config_revision: 1,
    integration: "exact-passthrough-test",
    rules: [
      {
        id: "test.reviewed-native-instruction",
        outcome: "safePassthrough",
        program_id: MEMO_PROGRAM,
        instruction: "ReviewedNativeInstruction",
        phase: "setup",
        emitted_by: ["test fixture"],
        condition: "only the exact reviewed fixture is accepted",
        discriminator: [42],
        rationale:
          "The exact program, bytes, account roles, and account identities are fixed by this test rule.",
        strict: {
          data: { kind: "exact", bytes: [42, 7] },
          fixed_accounts: [
            {
              index: 0,
              writable: false,
              signer: true,
              dynamic_account: "glam_signer",
            },
            {
              index: 1,
              writable: false,
              signer: false,
              account: PublicKey.default.toBase58(),
            },
          ],
          remaining_accounts: { kind: "none" },
        },
      },
      {
        id: "test.reviewed-native-instruction-variant",
        outcome: "safePassthrough",
        program_id: MEMO_PROGRAM,
        instruction: "ReviewedNativeInstructionVariant",
        phase: "setup",
        emitted_by: ["test fixture"],
        condition: "a second exact payload sharing the discriminator",
        discriminator: [42],
        rationale:
          "An exact second shape may coexist without widening the first allowlist.",
        strict: {
          data: { kind: "exact", bytes: [42, 9] },
          fixed_accounts: [
            {
              index: 0,
              writable: false,
              signer: true,
              dynamic_account: "glam_signer",
            },
            {
              index: 1,
              writable: false,
              signer: false,
              account: PublicKey.default.toBase58(),
            },
          ],
          remaining_accounts: { kind: "none" },
        },
      },
      {
        id: "test.unapproved-native-instruction",
        outcome: "unsupported",
        program_id: MEMO_PROGRAM,
        instruction: "UnapprovedNativeInstruction",
        phase: "setup",
        emitted_by: ["test fixture"],
        condition: "all other shapes sharing the discriminator",
        discriminator: [42],
        reason:
          "A shared discriminator does not widen either exact passthrough rule.",
      },
    ],
  } satisfies InstructionClassificationConfig,
  emptyMappings,
  environment,
);

const reviewedPassthroughInstruction: NeutralInstruction = {
  programAddress: MEMO_PROGRAM,
  accounts: [
    { address: glamSigner.toBase58(), role: 2 },
    { address: PublicKey.default.toBase58(), role: 0 },
  ],
  data: new Uint8Array([42, 7]),
};

function mapWithExactPassthroughRule(
  instruction: NeutralInstruction,
): NeutralMapInstructionResult {
  return mapInstructionWithConfigs(
    instruction,
    passthroughContext,
    emptyMappings,
    exactPassthroughConfig,
    environment,
  );
}

function cloneReviewedInstruction(
  patch: Partial<NeutralInstruction>,
): NeutralInstruction {
  return {
    programAddress:
      patch.programAddress ?? reviewedPassthroughInstruction.programAddress,
    accounts:
      patch.accounts ??
      reviewedPassthroughInstruction.accounts.map((account) => ({
        ...account,
      })),
    data: patch.data ?? reviewedPassthroughInstruction.data.slice(),
  };
}

describe("exact safe-passthrough classification", () => {
  it("returns a tagged, copied safePassthrough result for the exact rule", () => {
    const result = mapWithExactPassthroughRule(reviewedPassthroughInstruction);

    expect(result.kind).toBe("safePassthrough");
    if (result.kind !== "safePassthrough") {
      throw new Error(`${result.reason}: ${result.message}`);
    }
    expect(result.sourceInstructionName).toBe("ReviewedNativeInstruction");
    expect(result.instruction).toEqual(reviewedPassthroughInstruction);
    expect(result.instruction).not.toBe(reviewedPassthroughInstruction);
    expect(result.instruction.accounts).not.toBe(
      reviewedPassthroughInstruction.accounts,
    );
    expect(result.instruction.data).not.toBe(
      reviewedPassthroughInstruction.data,
    );
  });

  it("selects a second exact rule sharing the same discriminator", () => {
    const result = mapWithExactPassthroughRule(
      cloneReviewedInstruction({ data: new Uint8Array([42, 9]) }),
    );

    expect(result).toMatchObject({
      kind: "safePassthrough",
      sourceInstructionName: "ReviewedNativeInstructionVariant",
    });
  });

  it.each([
    {
      mutation: "program",
      expectedReason: "unsupported-program",
      instruction: () =>
        cloneReviewedInstruction({ programAddress: ASSOCIATED_TOKEN_PROGRAM }),
    },
    {
      mutation: "discriminator",
      expectedReason: "unsupported-program",
      instruction: () =>
        cloneReviewedInstruction({ data: new Uint8Array([43, 7]) }),
    },
    {
      mutation: "data",
      expectedReason: "invalid-data",
      instruction: () =>
        cloneReviewedInstruction({ data: new Uint8Array([42, 8]) }),
    },
    {
      mutation: "account count",
      expectedReason: "account-count",
      instruction: () =>
        cloneReviewedInstruction({
          accounts: reviewedPassthroughInstruction.accounts.slice(0, 1),
        }),
    },
    {
      mutation: "account role",
      expectedReason: "account-meta",
      instruction: () =>
        cloneReviewedInstruction({
          accounts: [
            { ...reviewedPassthroughInstruction.accounts[0], role: 3 },
            reviewedPassthroughInstruction.accounts[1],
          ],
        }),
    },
    {
      mutation: "account address",
      expectedReason: "account-address",
      instruction: () =>
        cloneReviewedInstruction({
          accounts: [
            reviewedPassthroughInstruction.accounts[0],
            {
              ...reviewedPassthroughInstruction.accounts[1],
              address: TOKEN_2022_PROGRAM.toBase58(),
            },
          ],
        }),
    },
  ])(
    "fails closed after a $mutation mutation",
    ({ instruction, expectedReason }) => {
      const result = mapWithExactPassthroughRule(instruction());

      expect(result.kind).toBe("unsupported");
      if (result.kind !== "unsupported") {
        throw new Error(`Expected unsupported, received ${result.kind}`);
      }
      expect(result.reason).toBe(expectedReason);
    },
  );

  it("fails closed for an explicitly unapproved permissionless SyncNative", () => {
    const result = neutralMapper.mapInstructionNeutral(
      {
        programAddress: TOKEN_PROGRAM.toBase58(),
        accounts: [{ address: getVaultPda(glamState).toBase58(), role: 1 }],
        data: new Uint8Array([17]),
      },
      mappingContext(false),
    );

    expect(result.kind).toBe("unsupported");
  });

  it("fails closed for an unknown permissionless program", () => {
    const result = neutralMapper.mapInstructionNeutral(
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: new Uint8Array([2, 1, 0, 0, 0]),
      },
      mappingContext(false),
    );

    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "unsupported-program",
    });
  });

  it("fails closed when a Kamino client uses a non-profile Farms program", () => {
    const result = neutralMapper.mapInstructionNeutral(
      {
        programAddress: PublicKey.unique().toBase58(),
        data: new Uint8Array([
          206, 176, 202, 18, 200, 209, 179, 108, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
      },
      mappingContext(false),
    );

    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "unsupported-program",
    });
  });
});
