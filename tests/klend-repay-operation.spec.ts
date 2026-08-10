import { PublicKey } from "@solana/web3.js";
import {
  address as kitAddress,
  none,
  some,
  type Address,
  type Option,
} from "@solana/kit";
import { refreshReserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/refreshReserve";
import { refreshObligation } from "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/refreshObligation";
import { repayObligationLiquidityV2 } from "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/repayObligationLiquidityV2";

import {
  createNeutralMapper,
  type KaminoLendingRepayContext,
  type MapKaminoLendingRepayOperationInput,
  type NeutralInstructionInput,
  type NeutralMapperEnvironment,
  type NeutralMappingContext,
} from "../src/core";
import { getIntegrationAuthority, getVaultPda } from "../src/pda";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const BN = require("bn.js");

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WRAPPED_SOL = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
const ASSOCIATED_TOKEN = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const FARMS = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const EXT_KAMINO = new PublicKey(
  "G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde",
);
const STAGING_EXT_KAMINO = new PublicKey(
  "gstgKa2Gq9wf5hM3DFWx1TvUrGYzDYszyFGq3XBY9Uq",
);
const glamState = new PublicKey("F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp");
const glamSigner = PublicKey.unique();

function addr(value: PublicKey): Address {
  return kitAddress(value.toBase58());
}

function option(value: PublicKey | null): Option<Address> {
  return value === null ? none() : some(addr(value));
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

function mappingContext(staging = false): NeutralMappingContext {
  const proxy = staging ? STAGING_EXT_KAMINO : EXT_KAMINO;
  return {
    glamStateAddress: glamState.toBase58(),
    glamVaultAddress: getVaultPda(glamState, staging).toBase58(),
    glamSignerAddress: glamSigner.toBase58(),
    integrationAuthorityByProxyProgram: {
      [proxy.toBase58()]: getIntegrationAuthority(proxy).toBase58(),
    },
  };
}

interface Fixture {
  input: MapKaminoLendingRepayOperationInput;
  context: NeutralMappingContext;
  target: PublicKey;
}

function deriveAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];
}

function fixture(staging = false): Fixture {
  const context = mappingContext(staging);
  const lendingMarket = PublicKey.unique();
  const obligation = PublicKey.unique();
  const depositOne = PublicKey.unique();
  const depositTwo = PublicKey.unique();
  const borrowOne = PublicKey.unique();
  const target = PublicKey.unique();
  const reserveLiquidityMint = PublicKey.unique();
  const reserveDestinationLiquidity = PublicKey.unique();
  const userSourceLiquidity = deriveAta(
    new PublicKey(context.glamVaultAddress),
    reserveLiquidityMint,
    TOKEN,
  );
  const marketAuthority = PublicKey.unique();
  const refreshOrder = [depositOne, depositTwo, borrowOne, target];
  const oracleBindings = refreshOrder.map((reserve, index) => ({
    reserve,
    pyth: index % 2 === 0 ? PublicKey.unique() : null,
    switchboardPrice: index === 1 ? PublicKey.unique() : null,
    switchboardTwap: index === 2 ? PublicKey.unique() : null,
  }));

  const refreshes = oracleBindings.map(
    ({ reserve, pyth, switchboardPrice, switchboardTwap }) =>
      refreshReserve(
        {
          reserve: addr(reserve),
          lendingMarket: addr(lendingMarket),
          pythOracle: option(pyth),
          switchboardPriceOracle: option(switchboardPrice),
          switchboardTwapOracle: option(switchboardTwap),
          scopePrices: none(),
        },
        [],
        addr(KLEND),
      ),
  );
  const obligationRefresh = refreshObligation(
    { lendingMarket: addr(lendingMarket), obligation: addr(obligation) },
    [depositOne, depositTwo, borrowOne, target].map((reserve) => ({
      address: addr(reserve),
      role: 1,
    })),
    addr(KLEND),
  );
  const repay = repayObligationLiquidityV2(
    { liquidityAmount: new BN(123_456) },
    {
      repayAccounts: {
        owner: { address: kitAddress(context.glamVaultAddress) } as never,
        obligation: addr(obligation),
        lendingMarket: addr(lendingMarket),
        repayReserve: addr(target),
        reserveLiquidityMint: addr(reserveLiquidityMint),
        reserveDestinationLiquidity: addr(reserveDestinationLiquidity),
        userSourceLiquidity: addr(userSourceLiquidity),
        tokenProgram: addr(TOKEN),
        instructionSysvarAccount: addr(SYSVAR),
      },
      farmsAccounts: {
        obligationFarmUserState: none(),
        reserveFarmState: none(),
      },
      lendingMarketAuthority: addr(marketAuthority),
      farmsProgram: addr(FARMS),
    },
    [],
    addr(KLEND),
  );
  const reviewedContext: KaminoLendingRepayContext = {
    stateObservationSlot: 1_000n,
    currentSlot: 1_010n,
    elevationGroup: 0,
    hasActiveFarms: false,
    hasFixedTermDebt: false,
    referrerAddress: null,
    sourceAtaExists: true,
    lendingMarketAddress: lendingMarket.toBase58(),
    obligationAddress: obligation.toBase58(),
    repayReserveAddress: target.toBase58(),
    reserveLiquidityMintAddress: reserveLiquidityMint.toBase58(),
    reserveDestinationLiquidityAddress: reserveDestinationLiquidity.toBase58(),
    userSourceLiquidityAddress: userSourceLiquidity.toBase58(),
    lendingMarketAuthorityAddress: marketAuthority.toBase58(),
    depositReserveAddresses: [depositOne.toBase58(), depositTwo.toBase58()],
    borrowReserveAddresses: [borrowOne.toBase58(), target.toBase58()],
    reserveRefreshBindings: oracleBindings.map(
      ({ reserve, pyth, switchboardPrice, switchboardTwap }) => ({
        reserveAddress: reserve.toBase58(),
        pythOracleAddress: pyth?.toBase58() ?? null,
        switchboardPriceOracleAddress: switchboardPrice?.toBase58() ?? null,
        switchboardTwapOracleAddress: switchboardTwap?.toBase58() ?? null,
        scopePricesAddress: null,
      }),
    ),
  };
  return {
    context,
    target,
    input: {
      operation: "repayObligationLiquidityV2",
      officialSdkVersion: "9.1.5",
      instructions: [...refreshes, obligationRefresh, repay],
      reviewedContext,
    },
  };
}

function mutateAccount(
  instruction: NeutralInstructionInput,
  index: number,
  patch: Partial<{ address: string; role: 0 | 1 | 2 | 3 }>,
): NeutralInstructionInput {
  const accounts = (instruction.accounts ?? []).map((account) => ({
    ...account,
  }));
  accounts[index] = { ...accounts[index], ...patch };
  return { ...instruction, accounts };
}

function replaceInstruction(
  input: MapKaminoLendingRepayOperationInput,
  index: number,
  instruction: NeutralInstructionInput,
): MapKaminoLendingRepayOperationInput {
  const instructions = [...input.instructions];
  instructions[index] = instruction;
  return { ...input, instructions };
}

describe("complete Klend repay-v2 operation mapping", () => {
  it("accepts the active official 9.1.5 tuple corpus atomically", async () => {
    const value = fixture();
    const result = await mapper.mapKaminoLendingRepayOperationNeutral(
      value.input,
      value.context,
    );

    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    expect(result.instructions.map(({ kind }) => kind)).toEqual([
      "safePassthrough",
      "safePassthrough",
      "safePassthrough",
      "safePassthrough",
      "safePassthrough",
      "mapped",
    ]);
    const mapped = result.instructions.at(-1);
    expect(mapped?.kind).toBe("mapped");
    if (mapped?.kind !== "mapped") throw new Error("missing mapped repay");
    expect(mapped.instruction.programAddress).toBe(EXT_KAMINO.toBase58());
    expect(mapped.instruction.accounts[15].address).toBe(EXT_KAMINO.toBase58());
    expect(mapped.instruction.accounts[16].address).toBe(EXT_KAMINO.toBase58());
  });

  it("keeps the 10.0.0 evaluation tuple out of the active runtime", async () => {
    const value = fixture();
    const result = await mapper.mapKaminoLendingRepayOperationNeutral(
      { ...value.input, officialSdkVersion: "10.0.0" as never },
      value.context,
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "operation-shape",
      instructionIndex: null,
    });
  });

  it("uses the staging proxy without changing the native helper corpus", async () => {
    const value = fixture(true);
    const result = await mapper.mapKaminoLendingRepayOperationNeutral(
      value.input,
      value.context,
      { staging: true },
    );
    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    const mapped = result.instructions.at(-1);
    expect(mapped?.kind).toBe("mapped");
    if (mapped?.kind !== "mapped") throw new Error("missing mapped repay");
    expect(mapped.instruction.programAddress).toBe(
      STAGING_EXT_KAMINO.toBase58(),
    );
  });

  it("does not expose refresh or repay as standalone mappings", () => {
    const value = fixture();
    expect(
      mapper.mapInstructionNeutral(value.input.instructions[0], value.context)
        .kind,
    ).toBe("unsupported");
    expect(
      mapper.mapInstructionNeutral(
        value.input.instructions.at(-1)!,
        value.context,
      ).kind,
    ).toBe("unsupported");
  });

  it("rejects reordered, omitted, and extra helper emissions", async () => {
    const value = fixture();
    const reordered = [...value.input.instructions];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    for (const instructions of [
      reordered,
      value.input.instructions.slice(1),
      [...value.input.instructions, value.input.instructions[0]],
    ]) {
      expect(
        (
          await mapper.mapKaminoLendingRepayOperationNeutral(
            { ...value.input, instructions },
            value.context,
          )
        ).kind,
      ).toBe("unsupported");
    }
  });

  it("rejects refresh role, identity, data, and tail changes", async () => {
    const value = fixture();
    const refresh = value.input.instructions[0];
    const obligationIndex = value.input.instructions.length - 2;
    const obligation = value.input.instructions[obligationIndex];
    const cases = [
      replaceInstruction(
        value.input,
        0,
        mutateAccount(refresh, 0, { role: 0 }),
      ),
      replaceInstruction(
        value.input,
        0,
        mutateAccount(refresh, 1, { address: PublicKey.unique().toBase58() }),
      ),
      replaceInstruction(value.input, 0, {
        ...refresh,
        data: Uint8Array.of(2, 218),
      }),
      replaceInstruction(
        value.input,
        obligationIndex,
        mutateAccount(obligation, 2, { role: 0 }),
      ),
      replaceInstruction(value.input, obligationIndex, {
        ...obligation,
        accounts: [
          ...(obligation.accounts ?? []),
          { address: PublicKey.unique().toBase58(), role: 1 },
        ],
      }),
    ];
    for (const input of cases) {
      expect(
        (
          await mapper.mapKaminoLendingRepayOperationNeutral(
            input,
            value.context,
          )
        ).kind,
      ).toBe("unsupported");
    }
  });

  it("rejects every repay account role, identity, remaining-account, and program variant", async () => {
    const value = fixture();
    const repayIndex = value.input.instructions.length - 1;
    const repay = value.input.instructions[repayIndex];
    const cases = [
      mutateAccount(repay, 0, { role: 3 }),
      mutateAccount(repay, 1, { address: PublicKey.unique().toBase58() }),
      mutateAccount(repay, 7, { address: TOKEN_2022.toBase58() }),
      mutateAccount(repay, 9, {
        address: PublicKey.unique().toBase58(),
        role: 1,
      }),
      mutateAccount(repay, 12, { address: PublicKey.unique().toBase58() }),
      {
        ...repay,
        accounts: [
          ...(repay.accounts ?? []),
          { address: PublicKey.unique().toBase58(), role: 1 as const },
        ],
      },
      { ...repay, programAddress: PublicKey.unique().toBase58() },
    ];
    for (const instruction of cases) {
      expect(
        (
          await mapper.mapKaminoLendingRepayOperationNeutral(
            replaceInstruction(value.input, repayIndex, instruction),
            value.context,
          )
        ).kind,
      ).toBe("unsupported");
    }
  });

  it("rejects zero, repay-all, changed discriminator, and trailing data", async () => {
    const value = fixture();
    const repayIndex = value.input.instructions.length - 1;
    const repay = value.input.instructions[repayIndex];
    const zero = new Uint8Array(repay.data as Uint8Array);
    zero.fill(0, 8);
    const repayAll = new Uint8Array(repay.data as Uint8Array);
    repayAll.fill(255, 8);
    const changed = new Uint8Array(repay.data as Uint8Array);
    changed[0] ^= 1;
    const trailing = new Uint8Array((repay.data?.length ?? 0) + 1);
    trailing.set(repay.data ?? []);
    for (const data of [zero, repayAll, changed, trailing]) {
      expect(
        (
          await mapper.mapKaminoLendingRepayOperationNeutral(
            replaceInstruction(value.input, repayIndex, { ...repay, data }),
            value.context,
          )
        ).kind,
      ).toBe("unsupported");
    }
  });

  it("binds helper order and oracle identities to the reviewed state snapshot", async () => {
    const value = fixture();
    const bindings = value.input.reviewedContext.reserveRefreshBindings.map(
      (binding) => ({ ...binding }),
    );
    bindings[0].pythOracleAddress = PublicKey.unique().toBase58();
    const result = await mapper.mapKaminoLendingRepayOperationNeutral(
      {
        ...value.input,
        reviewedContext: {
          ...value.input.reviewedContext,
          reserveRefreshBindings: bindings,
        },
      },
      value.context,
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "operation-binding",
      instructionIndex: 0,
    });
  });

  it("rejects duplicate/stale state, unsupported obligation branches, Scope, and wrapped SOL", async () => {
    const value = fixture();
    const firstDeposit = value.input.reviewedContext.depositReserveAddresses[0];
    const variants: KaminoLendingRepayContext[] = [
      {
        ...value.input.reviewedContext,
        depositReserveAddresses: [firstDeposit, firstDeposit],
      },
      {
        ...value.input.reviewedContext,
        borrowReserveAddresses:
          value.input.reviewedContext.borrowReserveAddresses.slice(0, 1),
      },
      {
        ...value.input.reviewedContext,
        reserveRefreshBindings:
          value.input.reviewedContext.reserveRefreshBindings.map(
            (binding, index) =>
              index === 0
                ? {
                    ...binding,
                    scopePricesAddress: PublicKey.unique().toBase58() as never,
                  }
                : binding,
          ),
      },
      {
        ...value.input.reviewedContext,
        reserveLiquidityMintAddress: WRAPPED_SOL.toBase58(),
      },
      {
        ...value.input.reviewedContext,
        currentSlot: 1_021n,
      },
      {
        ...value.input.reviewedContext,
        hasFixedTermDebt: true as never,
      },
      {
        ...value.input.reviewedContext,
        elevationGroup: 1 as never,
      },
      {
        ...value.input.reviewedContext,
        hasActiveFarms: true as never,
      },
      {
        ...value.input.reviewedContext,
        referrerAddress: PublicKey.unique().toBase58() as never,
      },
      {
        ...value.input.reviewedContext,
        sourceAtaExists: false as never,
      },
    ];
    for (const reviewedContext of variants) {
      expect(
        (
          await mapper.mapKaminoLendingRepayOperationNeutral(
            { ...value.input, reviewedContext },
            value.context,
          )
        ).kind,
      ).toBe("unsupported");
    }
  });

  it("requires the canonical GLAM-vault source ATA", async () => {
    const value = fixture();
    const repayIndex = value.input.instructions.length - 1;
    const arbitrarySource = PublicKey.unique().toBase58();
    const input = replaceInstruction(
      {
        ...value.input,
        reviewedContext: {
          ...value.input.reviewedContext,
          userSourceLiquidityAddress: arbitrarySource,
        },
      },
      repayIndex,
      mutateAccount(value.input.instructions[repayIndex], 6, {
        address: arbitrarySource,
      }),
    );
    const result = await mapper.mapKaminoLendingRepayOperationNeutral(
      input,
      value.context,
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      reason: "operation-binding",
      instructionIndex: null,
    });
  });

  it("copies the complete operation before returning mapped output", async () => {
    const value = fixture();
    const result = await mapper.mapKaminoLendingRepayOperationNeutral(
      value.input,
      value.context,
    );
    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    const original = result.instructions[0].instruction.accounts[0].address;
    const mutable = value.input.instructions[0].accounts as Array<{
      address: string;
      role: 0 | 1 | 2 | 3;
    }>;
    mutable[0].address = PublicKey.unique().toBase58();
    expect(result.instructions[0].instruction.accounts[0].address).toBe(
      original,
    );
  });

  it("snapshots mapping context and operation inputs before async ATA derivation", async () => {
    const value = fixture();
    const originalContext = {
      glamStateAddress: value.context.glamStateAddress,
      glamVaultAddress: value.context.glamVaultAddress,
      glamSignerAddress: value.context.glamSignerAddress,
      integrationAuthority: getIntegrationAuthority(EXT_KAMINO).toBase58(),
    };
    let mutateAfterSnapshot = (): void => {
      throw new Error("mutation callback was not installed");
    };
    const delayedMapper = createNeutralMapper({
      normalizeAddress: environment.normalizeAddress,
      async deriveAssociatedTokenAddress(input): Promise<string> {
        const derived = deriveAta(
          new PublicKey(input.ownerAddress),
          new PublicKey(input.mintAddress),
          new PublicKey(input.tokenProgramAddress),
        ).toBase58();
        mutateAfterSnapshot();
        await Promise.resolve();
        return derived;
      },
    });
    const mutableContext = {
      ...value.context,
      integrationAuthorityByProxyProgram: {
        ...value.context.integrationAuthorityByProxyProgram,
      },
    };
    const mutableInput = {
      ...value.input,
      instructions: value.input.instructions.map((instruction) => ({
        ...instruction,
        accounts: instruction.accounts?.map((account) => ({ ...account })),
        data: new Uint8Array(instruction.data ?? []),
      })),
      reviewedContext: {
        ...value.input.reviewedContext,
        depositReserveAddresses: [
          ...value.input.reviewedContext.depositReserveAddresses,
        ],
        borrowReserveAddresses: [
          ...value.input.reviewedContext.borrowReserveAddresses,
        ],
        reserveRefreshBindings:
          value.input.reviewedContext.reserveRefreshBindings.map((binding) => ({
            ...binding,
          })),
      },
    };
    mutateAfterSnapshot = () => {
      mutableContext.glamStateAddress = PublicKey.unique().toBase58();
      mutableContext.glamVaultAddress = PublicKey.unique().toBase58();
      mutableContext.glamSignerAddress = PublicKey.unique().toBase58();
      mutableContext.integrationAuthorityByProxyProgram[EXT_KAMINO.toBase58()] =
        PublicKey.unique().toBase58();
      mutableInput.instructions[0].accounts![0].address =
        PublicKey.unique().toBase58();
      mutableInput.reviewedContext.reserveRefreshBindings[0].reserveAddress =
        PublicKey.unique().toBase58();
    };

    const result = await delayedMapper.mapKaminoLendingRepayOperationNeutral(
      mutableInput,
      mutableContext,
    );
    expect(result.kind).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") throw new Error(result.message);
    expect(result.instructions[0].instruction.accounts[0].address).toBe(
      value.input.reviewedContext.reserveRefreshBindings[0].reserveAddress,
    );
    const mapped = result.instructions.at(-1);
    expect(mapped?.kind).toBe("mapped");
    if (mapped?.kind !== "mapped") throw new Error("missing mapped repay");
    expect(
      mapped.instruction.accounts.slice(0, 4).map(({ address }) => address),
    ).toEqual([
      originalContext.glamStateAddress,
      originalContext.glamVaultAddress,
      originalContext.glamSignerAddress,
      originalContext.integrationAuthority,
    ]);
  });
});
