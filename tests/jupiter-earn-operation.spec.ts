import BN from "bn.js";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import * as officialEarn from "@jup-ag/lend/earn";

import JupiterVectors from "../artifacts/jupiter-lend/0.1.10/operation-vectors.json";
import JupiterStrictConfig from "../mapping-configs-v2/jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9.json";
import JupiterOperationProfiles from "../operation-profiles-v2/jupiter-earn.json";
import {
  createNeutralMapper,
  type JupiterEarnExternalProfile,
  type JupiterEarnReviewedContext,
  type MapJupiterEarnOperationInput,
  type NeutralInstructionInput,
  type NeutralMapperEnvironment,
  type NeutralMappingContext,
} from "../src/core";
import {
  validateJupiterOperationProfileConfig,
} from "../src/jupiter-operation";
import { getIntegrationAuthority } from "../src/pda";
import { validateStrictRemappingConfigs } from "../src/strict";

const LENDING = new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
const LIQUIDITY = new PublicKey("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
const REWARD_RATE_MODEL = new PublicKey(
  "jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar",
);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const EXT_JUPITER = new PublicKey("G1NTJX2noRfJeKS7NDgjsqUXcJ7R9yARED1LQvg7iwSK");
const STAGING_EXT_JUPITER = new PublicKey(
  "gstgJbGqoE3p1SdFA2dET9tcaCzNqGcdD8wpbGctnU9",
);

function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];
}

function derivePda(
  program: PublicKey,
  seeds: readonly (
    | { kind: "utf8"; value: string }
    | { kind: "address"; value: string }
  )[],
) {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) =>
      seed.kind === "utf8"
        ? Buffer.from(seed.value)
        : new PublicKey(seed.value).toBuffer(),
    ),
    program,
  )[0];
}

const environment: NeutralMapperEnvironment = {
  normalizeAddress(value) {
    return new PublicKey(value).toBase58();
  },
  async deriveAssociatedTokenAddress(input) {
    return deriveAta(
      new PublicKey(input.ownerAddress),
      new PublicKey(input.mintAddress),
      new PublicKey(input.tokenProgramAddress),
    ).toBase58();
  },
  async deriveProgramAddress(input) {
    return derivePda(new PublicKey(input.programAddress), input.seeds).toBase58();
  },
};

const externalProfile: JupiterEarnExternalProfile = Object.freeze({
  profile: "jupiter-earn-main-classic-spl-v1",
  market: "main",
  lendingProgramAddress: LENDING.toBase58(),
  liquidityProgramAddress: LIQUIDITY.toBase58(),
  rewardRateModelProgramAddress: REWARD_RATE_MODEL.toBase58(),
  assetTokenProgramAddress: TOKEN.toBase58(),
  fTokenProgramAddress: TOKEN.toBase58(),
  associatedTokenProgramAddress: ASSOCIATED_TOKEN.toBase58(),
  systemProgramAddress: SYSTEM.toBase58(),
  setup: "none",
  baseCommit: "4053ffbad104ce7f17505f4b3b85d5b1b414fc37",
  hardeningCommit: "356ed8420edc24ceb518d88440f4e17c24378c61",
});

function mappingContext(staging = false): NeutralMappingContext {
  const proxy = staging ? STAGING_EXT_JUPITER : EXT_JUPITER;
  return {
    glamStateAddress: PublicKey.unique().toBase58(),
    glamVaultAddress: JupiterVectors.owner,
    glamSignerAddress: PublicKey.unique().toBase58(),
    integrationAuthorityByProxyProgram: {
      [proxy.toBase58()]: getIntegrationAuthority(proxy).toBase58(),
    },
  };
}

function instruction(
  operation: "depositWithMinAmountOut" | "redeemWithMinAmountOut",
): NeutralInstructionInput {
  const vector =
    operation === "depositWithMinAmountOut"
      ? JupiterVectors.deposit.instruction
      : JupiterVectors.redeem.instruction;
  return {
    programAddress: vector.programAddress,
    accounts: vector.accounts.map((account) => ({
      address: account.address,
      role: account.role as 0 | 1 | 2 | 3,
    })),
    data: new Uint8Array(vector.data),
  };
}

function reviewedContext(): JupiterEarnReviewedContext {
  return {
    stateObservationSlot: BigInt(JupiterVectors.source.slot),
    currentSlot: BigInt(JupiterVectors.source.slot + 5),
    underlyingAtaExists: true,
    fTokenAtaExists: true,
    lending: { ...JupiterVectors.lending },
    tokenReserve: { ...JupiterVectors.tokenReserve },
  };
}

function fixture(
  operation: "depositWithMinAmountOut" | "redeemWithMinAmountOut" =
    "depositWithMinAmountOut",
  staging = false,
) {
  const native = instruction(operation);
  const input: MapJupiterEarnOperationInput = {
    operation,
    officialSdkVersion: "0.1.10",
    externalProfile: { ...externalProfile },
    instructions: [native],
    reviewedContext: reviewedContext(),
  };
  return { input, context: mappingContext(staging), native };
}

function cloneInstruction(
  value: NeutralInstructionInput,
): NeutralInstructionInput {
  return {
    programAddress: value.programAddress,
    accounts: value.accounts?.map((account) => ({ ...account })),
    data: new Uint8Array(value.data ?? []),
  };
}

function comparable(value: TransactionInstruction) {
  return {
    programAddress: value.programId.toBase58(),
    accounts: value.keys.map((account) => ({
      address: account.pubkey.toBase58(),
      role: ((account.isSigner ? 2 : 0) |
        (account.isWritable ? 1 : 0)) as 0 | 1 | 2 | 3,
    })),
    data: [...value.data],
  };
}

function officialAccounts(
  entries: Readonly<Record<string, string>>,
): Record<string, PublicKey> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, address]) => [
      name,
      new PublicKey(address),
    ]),
  );
}

async function officialInstructions() {
  const signer = new PublicKey(JupiterVectors.owner);
  const program = officialEarn.getLendingProgram({
    connection: new Connection("http://127.0.0.1:8899", "confirmed"),
    signer,
    market: "main",
  });
  const deposit = await program.methods
    .depositWithMinAmountOut(
      new BN(JupiterVectors.deposit.assets),
      new BN(JupiterVectors.deposit.minAmountOut),
    )
    .accounts(
      officialAccounts({
        signer: JupiterVectors.owner,
        depositorTokenAccount:
          JupiterVectors.deposit.instruction.accounts[1].address,
        recipientTokenAccount:
          JupiterVectors.deposit.instruction.accounts[2].address,
        mint: JupiterVectors.lending.mintAddress,
        lendingAdmin: JupiterVectors.deposit.instruction.accounts[4].address,
        lending: JupiterVectors.lending.address,
        fTokenMint: JupiterVectors.lending.fTokenMintAddress,
        supplyTokenReservesLiquidity:
          JupiterVectors.lending.tokenReservesLiquidityAddress,
        lendingSupplyPositionOnLiquidity:
          JupiterVectors.lending.supplyPositionOnLiquidityAddress,
        rateModel: JupiterVectors.deposit.instruction.accounts[9].address,
        vault: JupiterVectors.tokenReserve.vaultAddress,
        liquidity: JupiterVectors.deposit.instruction.accounts[11].address,
        liquidityProgram: LIQUIDITY.toBase58(),
        rewardsRateModel: JupiterVectors.lending.rewardsRateModelAddress,
        tokenProgram: TOKEN.toBase58(),
        associatedTokenProgram: ASSOCIATED_TOKEN.toBase58(),
        systemProgram: SYSTEM.toBase58(),
      }),
    )
    .instruction();
  const redeem = await program.methods
    .redeemWithMinAmountOut(
      new BN(JupiterVectors.redeem.shares),
      new BN(JupiterVectors.redeem.minAmountOut),
    )
    .accounts(
      officialAccounts({
        signer: JupiterVectors.owner,
        ownerTokenAccount: JupiterVectors.redeem.instruction.accounts[1].address,
        recipientTokenAccount:
          JupiterVectors.redeem.instruction.accounts[2].address,
        lendingAdmin: JupiterVectors.redeem.instruction.accounts[3].address,
        lending: JupiterVectors.lending.address,
        mint: JupiterVectors.lending.mintAddress,
        fTokenMint: JupiterVectors.lending.fTokenMintAddress,
        supplyTokenReservesLiquidity:
          JupiterVectors.lending.tokenReservesLiquidityAddress,
        lendingSupplyPositionOnLiquidity:
          JupiterVectors.lending.supplyPositionOnLiquidityAddress,
        rateModel: JupiterVectors.redeem.instruction.accounts[9].address,
        vault: JupiterVectors.tokenReserve.vaultAddress,
        claimAccount: JupiterVectors.redeem.instruction.accounts[11].address,
        liquidity: JupiterVectors.redeem.instruction.accounts[12].address,
        liquidityProgram: LIQUIDITY.toBase58(),
        rewardsRateModel: JupiterVectors.lending.rewardsRateModelAddress,
        tokenProgram: TOKEN.toBase58(),
        associatedTokenProgram: ASSOCIATED_TOKEN.toBase58(),
        systemProgram: SYSTEM.toBase58(),
      }),
    )
    .instruction();
  return { deposit, redeem };
}

describe("proof-only Jupiter Earn bounded operations", () => {
  const mapper = createNeutralMapper(environment);

  it("matches official SDK builders to committed portable-binding vectors", async () => {
    const official = await officialInstructions();
    expect(comparable(official.deposit)).toEqual(
      JupiterVectors.deposit.instruction,
    );
    expect(comparable(official.redeem)).toEqual(
      JupiterVectors.redeem.instruction,
    );
  });

  it.each([
    ["depositWithMinAmountOut", false, EXT_JUPITER, [81, 98, 113, 207, 82, 192, 187, 234], 22],
    ["redeemWithMinAmountOut", false, EXT_JUPITER, [204, 196, 159, 42, 52, 107, 134, 153], 23],
    ["depositWithMinAmountOut", true, STAGING_EXT_JUPITER, [81, 98, 113, 207, 82, 192, 187, 234], 22],
    ["redeemWithMinAmountOut", true, STAGING_EXT_JUPITER, [204, 196, 159, 42, 52, 107, 134, 153], 23],
  ] as const)(
    "maps exact %s vector atomically (staging=%s)",
    async (operation, staging, proxy, discriminator, accountCount) => {
      const value = fixture(operation, staging);
      const result = await mapper.mapJupiterEarnOperationNeutral(
        value.input,
        value.context,
        { staging },
      );
      expect(result.kind, JSON.stringify(result)).toBe("mappedOperation");
      if (result.kind !== "mappedOperation") return;
      expect(result.instructions).toHaveLength(1);
      expect(result.instructions[0].kind).toBe("mapped");
      expect(result.instructions[0].instruction.programAddress).toBe(
        proxy.toBase58(),
      );
      expect(result.instructions[0].instruction.accounts).toHaveLength(
        accountCount,
      );
      expect(
        Array.from(result.instructions[0].instruction.data.subarray(0, 8)),
      ).toEqual(discriminator);
      expect(
        Array.from(result.instructions[0].instruction.data.subarray(8)),
      ).toEqual(Array.from(value.native.data!.subarray(8)));
    },
  );

  it("keeps both native Jupiter instructions operation-only", () => {
    for (const operation of [
      "depositWithMinAmountOut",
      "redeemWithMinAmountOut",
    ] as const) {
      const value = fixture(operation);
      expect(
        mapper.mapInstructionNeutral(value.native, value.context),
      ).toMatchObject({ kind: "unsupported" });
    }
  });

  it("rejects every account role, identity, tail, and duplicate mutation", async () => {
    for (const operation of [
      "depositWithMinAmountOut",
      "redeemWithMinAmountOut",
    ] as const) {
      const value = fixture(operation);
      for (let index = 0; index < value.native.accounts!.length; index += 1) {
        const role = cloneInstruction(value.native);
        (role.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[
          index
        ].role = ((role.accounts![index].role + 1) % 4) as 0 | 1 | 2 | 3;
        expect(
          await mapper.mapJupiterEarnOperationNeutral(
            { ...value.input, instructions: [role] },
            value.context,
          ),
        ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });

        const identity = cloneInstruction(value.native);
        (identity.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[
          index
        ].address = PublicKey.unique().toBase58();
        expect(
          await mapper.mapJupiterEarnOperationNeutral(
            { ...value.input, instructions: [identity] },
            value.context,
          ),
        ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
      }
      const extra = cloneInstruction(value.native);
      (extra.accounts as { address: string; role: 0 | 1 | 2 | 3 }[]).push({
        address: PublicKey.unique().toBase58(),
        role: 0,
      });
      expect(
        await mapper.mapJupiterEarnOperationNeutral(
          { ...value.input, instructions: [extra] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
      expect(
        await mapper.mapJupiterEarnOperationNeutral(
          { ...value.input, instructions: [value.native, value.native] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: null });
    }
  }, 30_000);

  it("rejects zero amounts, data tails, and accepts exact u64 maxima", async () => {
    for (const offset of [8, 16]) {
      const value = fixture();
      const changed = cloneInstruction(value.native);
      const data = new Uint8Array(changed.data!);
      data.fill(0, offset, offset + 8);
      expect(
        await mapper.mapJupiterEarnOperationNeutral(
          { ...value.input, instructions: [{ ...changed, data }] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
    }
    const value = fixture();
    const max = cloneInstruction(value.native);
    const maxData = new Uint8Array(max.data!);
    maxData.fill(255, 8, 24);
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        { ...value.input, instructions: [{ ...max, data: maxData }] },
        value.context,
      ),
    ).toMatchObject({ kind: "mappedOperation" });

    const tailed = new Uint8Array(value.native.data!.length + 1);
    tailed.set(value.native.data!);
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        { ...value.input, instructions: [{ ...value.native, data: tailed }] },
        value.context,
      ),
    ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
  });

  it.each([
    ["lending.address"],
    ["lending.mintAddress"],
    ["lending.fTokenMintAddress"],
    ["lending.tokenReservesLiquidityAddress"],
    ["tokenReserve.address"],
    ["tokenReserve.mintAddress"],
  ] as const)("rejects decoded relationship mutation %s", async (path) => {
    const value = fixture();
    const [group, field] = path.split(".") as [
      "lending" | "tokenReserve",
      string,
    ];
    const reviewed = {
      ...value.input.reviewedContext,
      [group]: {
        ...value.input.reviewedContext[group],
        [field]: PublicKey.unique().toBase58(),
      },
    };
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        { ...value.input, reviewedContext: reviewed as never },
        value.context,
      ),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("rejects paired state and native-account mutations of derived identities", async () => {
    for (const operation of [
      "depositWithMinAmountOut",
      "redeemWithMinAmountOut",
    ] as const) {
      for (const identity of [
        "reserve",
        "supply",
        "rewards",
        "vault",
      ] as const) {
        const value = fixture(operation);
        const native = cloneInstruction(value.native);
        const reviewed = structuredClone(
          value.input.reviewedContext,
        ) as unknown as {
          lending: Record<string, string>;
          tokenReserve: Record<string, string>;
        };
        const replacement = PublicKey.unique().toBase58();
        const accountIndex =
          identity === "reserve"
            ? 7
            : identity === "supply"
              ? 8
              : identity === "vault"
                ? 10
                : operation === "depositWithMinAmountOut"
                  ? 13
                  : 14;
        (
          native.accounts as { address: string; role: 0 | 1 | 2 | 3 }[]
        )[accountIndex].address = replacement;
        if (identity === "reserve") {
          reviewed.lending.tokenReservesLiquidityAddress = replacement;
          reviewed.tokenReserve.address = replacement;
        } else if (identity === "supply") {
          reviewed.lending.supplyPositionOnLiquidityAddress = replacement;
        } else if (identity === "rewards") {
          reviewed.lending.rewardsRateModelAddress = replacement;
        } else {
          reviewed.tokenReserve.vaultAddress = replacement;
        }
        expect(
          await mapper.mapJupiterEarnOperationNeutral(
            {
              ...value.input,
              instructions: [native],
              reviewedContext: reviewed as never,
            },
            value.context,
          ),
        ).toMatchObject({ kind: "unsupported", reason: "operation-binding" });
      }
    }
  });

  it.each([
    { underlyingAtaExists: false },
    { fTokenAtaExists: false },
    { currentSlot: BigInt(JupiterVectors.source.slot + 21) },
  ])("rejects excluded reviewed context %#", async (change) => {
    const value = fixture();
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        {
          ...value.input,
          reviewedContext: {
            ...value.input.reviewedContext,
            ...change,
          } as never,
        },
        value.context,
      ),
    ).toMatchObject({ kind: "unsupported", reason: "operation-shape" });
  });

  it.each([
    ["lending", LIQUIDITY.toBase58()],
    ["tokenReserve", LENDING.toBase58()],
  ] as const)("rejects a %s state owner outside its reviewed program", async (field, owner) => {
    const value = fixture();
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        {
          ...value.input,
          reviewedContext: {
            ...value.input.reviewedContext,
            [field]: {
              ...value.input.reviewedContext[field],
              ownerProgramAddress: owner,
            },
          },
        },
        value.context,
      ),
    ).toMatchObject({ kind: "unsupported", reason: "operation-shape" });
  });

  it("rejects wrapped SOL and Token-2022 profile mutations", async () => {
    const value = fixture();
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        {
          ...value.input,
          reviewedContext: {
            ...value.input.reviewedContext,
            lending: {
              ...value.input.reviewedContext.lending,
              mintAddress: WSOL.toBase58(),
            },
            tokenReserve: {
              ...value.input.reviewedContext.tokenReserve,
              mintAddress: WSOL.toBase58(),
            },
          },
        },
        value.context,
      ),
    ).toMatchObject({ kind: "unsupported" });
    expect(
      await mapper.mapJupiterEarnOperationNeutral(
        {
          ...value.input,
          externalProfile: {
            ...value.input.externalProfile,
            assetTokenProgramAddress: TOKEN_2022.toBase58(),
          },
        },
        value.context,
      ),
    ).toMatchObject({ kind: "unsupported", reason: "operation-shape" });
  });

  it("rejects every external-profile field mutation", async () => {
    const value = fixture();
    for (const field of Object.keys(value.input.externalProfile)) {
      const replacement =
        field.endsWith("Address")
          ? PublicKey.unique().toBase58()
          : field === "market"
            ? "ethena"
            : field === "setup"
              ? "create-associated-token-account"
              : "drift";
      expect(
        await mapper.mapJupiterEarnOperationNeutral(
          {
            ...value.input,
            externalProfile: {
              ...value.input.externalProfile,
              [field]: replacement,
            } as never,
          },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", reason: "operation-shape" });
    }
  });

  it("fails closed without deterministic ATA/PDA bindings", async () => {
    const value = fixture();
    for (const missing of [
      "deriveAssociatedTokenAddress",
      "deriveProgramAddress",
    ] as const) {
      const partial = { ...environment };
      delete partial[missing];
      expect(
        await createNeutralMapper(
          partial,
        ).mapJupiterEarnOperationNeutral(value.input, value.context),
      ).toMatchObject({ kind: "unsupported", reason: "operation-binding" });
    }
  });

  it("snapshots all mutable inputs before async derivation", async () => {
    const value = fixture();
    const mutableContext = {
      ...value.context,
      integrationAuthorityByProxyProgram: {
        ...value.context.integrationAuthorityByProxyProgram,
      },
    };
    const mutableInput = {
      ...value.input,
      externalProfile: { ...value.input.externalProfile },
      reviewedContext: {
        ...value.input.reviewedContext,
        lending: { ...value.input.reviewedContext.lending },
        tokenReserve: { ...value.input.reviewedContext.tokenReserve },
      },
      instructions: value.input.instructions.map(cloneInstruction),
    };
    const hostile: NeutralMapperEnvironment = {
      ...environment,
      async deriveAssociatedTokenAddress(input) {
        mutableContext.glamVaultAddress = PublicKey.unique().toBase58();
        mutableInput.externalProfile.lendingProgramAddress =
          PublicKey.unique().toBase58();
        mutableInput.reviewedContext.lending.address =
          PublicKey.unique().toBase58();
        (
          mutableInput.instructions[0].accounts as {
            address: string;
            role: number;
          }[]
        )[0].address = PublicKey.unique().toBase58();
        return environment.deriveAssociatedTokenAddress!(input);
      },
    };
    expect(
      await createNeutralMapper(hostile).mapJupiterEarnOperationNeutral(
        mutableInput,
        mutableContext,
      ),
    ).toMatchObject({ kind: "mappedOperation" });
  });

  it("rejects runtime profile drift from the external tuple and slot bound", () => {
    const configs = validateStrictRemappingConfigs(
      {
        [LENDING.toBase58()]: structuredClone(JupiterStrictConfig) as never,
      },
      environment,
    );
    for (const mutate of [
      (profile: typeof JupiterOperationProfiles) => {
        profile.operations[0].maximum_snapshot_age_slots = 21 as never;
      },
      (profile: typeof JupiterOperationProfiles) => {
        profile.operations[0].external_profile.market = "ethena" as never;
      },
    ]) {
      const profile = structuredClone(JupiterOperationProfiles);
      mutate(profile);
      expect(() =>
        validateJupiterOperationProfileConfig(
          profile as never,
          configs,
          environment,
        ),
      ).toThrow();
    }
  });
});
