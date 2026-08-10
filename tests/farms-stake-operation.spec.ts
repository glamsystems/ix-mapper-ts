import { PublicKey } from "@solana/web3.js";
import {
  address as kitAddress,
  createNoopSigner,
  none,
  type Address,
} from "@solana/kit";
import Decimal from "decimal.js";
import { Farms } from "@kamino-finance/farms-sdk/dist/Farms";
import { getInitializeUserInstruction } from "@kamino-finance/farms-sdk/dist/@codegen/farms/instructions/initializeUser";
import { getStakeInstruction } from "@kamino-finance/farms-sdk/dist/@codegen/farms/instructions/stake";
import FarmsStrictConfig from "../mapping-configs-v2/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";
import FarmsOperationProfiles from "../operation-profiles-v2/kamino-farms-stake.json";

import {
  createNeutralMapper,
  type KaminoFarmsStakeContext,
  type MapKaminoFarmsStakeOperationInput,
  type NeutralInstructionInput,
  type NeutralMapperEnvironment,
  type NeutralMappingContext,
} from "../src/core";
import { getIntegrationAuthority, getVaultPda } from "../src/pda";
import { validateFarmsOperationProfileConfig } from "../src/farms-operation";
import { validateStrictRemappingConfigs } from "../src/strict";

const FARMS = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const EXT_KAMINO = new PublicKey("G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde");
const STAGING_EXT_KAMINO = new PublicKey("gstgKa2Gq9wf5hM3DFWx1TvUrGYzDYszyFGq3XBY9Uq");
const glamState = new PublicKey("F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp");
const glamSigner = PublicKey.unique();

function addr(value: PublicKey): Address {
  return kitAddress(value.toBase58());
}

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
    return kitAddress(value);
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
  input: MapKaminoFarmsStakeOperationInput;
  context: NeutralMappingContext;
  initialize?: NeutralInstructionInput;
  stake: NeutralInstructionInput;
}

async function fixture(
  operation: "stake" | "initializeAndStake" = "stake",
  staging = false,
): Promise<Fixture> {
  const context = mappingContext(staging);
  const owner = new PublicKey(context.glamVaultAddress);
  const signer = createNoopSigner(addr(owner));
  const farm = PublicKey.unique();
  const mint = PublicKey.unique();
  const userState = derivePda(FARMS, [
    { kind: "utf8", value: "user" },
    { kind: "address", value: farm.toBase58() },
    { kind: "address", value: owner.toBase58() },
  ]);
  const farmVault = derivePda(FARMS, [
    { kind: "utf8", value: "fvault" },
    { kind: "address", value: farm.toBase58() },
    { kind: "address", value: mint.toBase58() },
  ]);
  const sourceAta = deriveAta(owner, mint);
  const farms = new Farms({} as never);
  const initialize =
    operation === "initializeAndStake"
      ? await farms.createNewUserIx(signer, addr(farm))
      : undefined;
  const stake = await farms.stakeIx(
    signer,
    addr(farm),
    new Decimal(123_456),
    addr(mint),
    none(),
  );
  const reviewedContext: KaminoFarmsStakeContext = {
    stateObservationSlot: 100n,
    currentSlot: 105n,
    userStateExists: operation === "stake",
    sourceAtaExists: true,
    isFarmDelegated: false,
    isObligationFarm: false,
    farmStateAddress: farm.toBase58(),
    stakeMintAddress: mint.toBase58(),
    farmVaultAddress: farmVault.toBase58(),
    userStateAddress: userState.toBase58(),
    userSourceAtaAddress: sourceAta.toBase58(),
    farmTokenProgramAddress: TOKEN.toBase58(),
    farmScopePricesAddress: SYSTEM.toBase58(),
  };
  return {
    context,
    initialize,
    stake,
    input: {
      operation,
      officialSdkVersion: "3.2.26",
      instructions: initialize ? [initialize, stake] : [stake],
      reviewedContext,
    },
  };
}

function cloneInstruction(instruction: NeutralInstructionInput): NeutralInstructionInput {
  return {
    programAddress: instruction.programAddress,
    accounts: instruction.accounts?.map((account) => ({ ...account })),
    data: new Uint8Array(instruction.data ?? []),
  };
}

function expectInstructionEquivalent(
  actual: NeutralInstructionInput,
  expected: NeutralInstructionInput,
) {
  expect(actual.programAddress).toBe(expected.programAddress);
  expect(
    actual.accounts?.map(({ address, role }) => ({ address, role })),
  ).toEqual(expected.accounts?.map(({ address, role }) => ({ address, role })));
  expect(Array.from(actual.data ?? [])).toEqual(Array.from(expected.data ?? []));
}

describe("proof-only Kamino Farms stake operation", () => {
  const mapper = createNeutralMapper(environment);

  it.each([
    ["stake", false, 1],
    ["initializeAndStake", false, 2],
    ["stake", true, 1],
    ["initializeAndStake", true, 2],
  ] as const)("maps exact %s helper output (staging=%s)", async (operation, staging, count) => {
    const value = await fixture(operation, staging);
    const result = await mapper.mapKaminoFarmsStakeOperationNeutral(
      value.input,
      value.context,
      { staging },
    );
    expect(result.kind, JSON.stringify(result)).toBe("mappedOperation");
    if (result.kind !== "mappedOperation") return;
    expect(result.instructions).toHaveLength(count);
    expect(result.instructions.every((entry) => entry.kind === "mapped")).toBe(true);
    expect(result.instructions.at(-1)?.instruction.programAddress).toBe(
      (staging ? STAGING_EXT_KAMINO : EXT_KAMINO).toBase58(),
    );
    expect(Array.from(result.instructions.at(-1)!.instruction.data.subarray(0, 8))).toEqual([
      224, 105, 208, 179, 98, 200, 213, 238,
    ]);
  });

  it("proves high-level helper output equals pinned generated builders", async () => {
    const value = await fixture("initializeAndStake");
    const owner = createNoopSigner(kitAddress(value.context.glamVaultAddress));
    const farm = kitAddress(value.input.reviewedContext.farmStateAddress);
    const userState = kitAddress(value.input.reviewedContext.userStateAddress);
    const mint = kitAddress(value.input.reviewedContext.stakeMintAddress);
    const directInit = getInitializeUserInstruction({
      authority: owner,
      payer: owner,
      owner: owner.address,
      delegatee: owner.address,
      userState,
      farmState: farm,
    });
    const directStake = getStakeInstruction({
      owner,
      userState,
      farmState: farm,
      farmVault: kitAddress(value.input.reviewedContext.farmVaultAddress),
      userAta: kitAddress(value.input.reviewedContext.userSourceAtaAddress),
      tokenMint: mint,
      scopePrices: null,
      amount: 123_456n,
    });
    expectInstructionEquivalent(value.initialize!, directInit);
    expectInstructionEquivalent(value.stake, directStake);
  });

  it("keeps Farms mappings operation-only", async () => {
    const value = await fixture();
    expect(
      mapper.mapInstructionNeutral(value.stake, value.context),
    ).toMatchObject({ kind: "unsupported", reason: "unsupported-program" });
  });

  it.each([
    "userStateAddress",
    "farmVaultAddress",
    "userSourceAtaAddress",
  ] as const)("rejects a non-canonical %s", async (field) => {
    const value = await fixture();
    const input = {
      ...value.input,
      reviewedContext: {
        ...value.input.reviewedContext,
        [field]: PublicKey.unique().toBase58(),
      },
    };
    await expect(
      mapper.mapKaminoFarmsStakeOperationNeutral(input, value.context),
    ).resolves.toMatchObject({ kind: "unsupported", reason: "operation-binding" });
  });

  it.each([
    { isFarmDelegated: true },
    { isObligationFarm: true },
    { sourceAtaExists: false },
    { farmTokenProgramAddress: TOKEN_2022.toBase58() },
    { farmScopePricesAddress: PublicKey.unique().toBase58() },
    { currentSlot: 121n },
  ])("rejects excluded decoded-state branch %#", async (change) => {
    const value = await fixture();
    const input = {
      ...value.input,
      reviewedContext: { ...value.input.reviewedContext, ...change },
    } as never;
    await expect(
      mapper.mapKaminoFarmsStakeOperationNeutral(input, value.context),
    ).resolves.toMatchObject({ kind: "unsupported", reason: "operation-shape" });
  });

  it("rejects zero, max, and tailed stake data", async () => {
    for (const amount of [0n, (1n << 64n) - 1n]) {
      const value = await fixture();
      const stake = cloneInstruction(value.stake);
      const data = new Uint8Array(stake.data!);
      for (let index = 0; index < 8; index += 1) {
        data[8 + index] = Number((amount >> BigInt(index * 8)) & 255n);
      }
      const result = await mapper.mapKaminoFarmsStakeOperationNeutral(
        { ...value.input, instructions: [{ ...stake, data }] },
        value.context,
      );
      expect(result).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
    }
    const value = await fixture();
    const stake = cloneInstruction(value.stake);
    const data = new Uint8Array(stake.data!.length + 1);
    data.set(stake.data!);
    await expect(
      mapper.mapKaminoFarmsStakeOperationNeutral(
        { ...value.input, instructions: [{ ...stake, data }] },
        value.context,
      ),
    ).resolves.toMatchObject({ kind: "unsupported", instructionIndex: 0 });
  });

  it("rejects every account role, identity, and remaining-account mutation", async () => {
    const value = await fixture();
    for (let index = 0; index < value.stake.accounts!.length; index += 1) {
      const roleMutation = cloneInstruction(value.stake);
      (roleMutation.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[index].role =
        ((roleMutation.accounts![index].role + 1) % 4) as 0 | 1 | 2 | 3;
      expect(
        await mapper.mapKaminoFarmsStakeOperationNeutral(
          { ...value.input, instructions: [roleMutation] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });

      const identityMutation = cloneInstruction(value.stake);
      (identityMutation.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[index].address =
        PublicKey.unique().toBase58();
      expect(
        await mapper.mapKaminoFarmsStakeOperationNeutral(
          { ...value.input, instructions: [identityMutation] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
    }
    const extraAccount = cloneInstruction(value.stake);
    (extraAccount.accounts as { address: string; role: 0 | 1 | 2 | 3 }[]).push({
      address: PublicKey.unique().toBase58(),
      role: 0,
    });
    await expect(
      mapper.mapKaminoFarmsStakeOperationNeutral(
        { ...value.input, instructions: [extraAccount] },
        value.context,
      ),
    ).resolves.toMatchObject({ kind: "unsupported", instructionIndex: 0 });
  });

  it("rejects every initialize_user role, identity, and extra-account mutation", async () => {
    const value = await fixture("initializeAndStake");
    for (let index = 0; index < value.initialize!.accounts!.length; index += 1) {
      const roleMutation = cloneInstruction(value.initialize!);
      (roleMutation.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[index].role =
        ((roleMutation.accounts![index].role + 1) % 4) as 0 | 1 | 2 | 3;
      expect(
        await mapper.mapKaminoFarmsStakeOperationNeutral(
          { ...value.input, instructions: [roleMutation, value.stake] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });

      const identityMutation = cloneInstruction(value.initialize!);
      (identityMutation.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[index].address =
        PublicKey.unique().toBase58();
      expect(
        await mapper.mapKaminoFarmsStakeOperationNeutral(
          { ...value.input, instructions: [identityMutation, value.stake] },
          value.context,
        ),
      ).toMatchObject({ kind: "unsupported", instructionIndex: 0 });
    }
    const extra = cloneInstruction(value.initialize!);
    (extra.accounts as { address: string; role: 0 | 1 | 2 | 3 }[]).push({
      address: PublicKey.unique().toBase58(),
      role: 0,
    });
    await expect(
      mapper.mapKaminoFarmsStakeOperationNeutral(
        { ...value.input, instructions: [extra, value.stake] },
        value.context,
      ),
    ).resolves.toMatchObject({ kind: "unsupported", instructionIndex: 0 });
  });

  it("allows only the exact declared duplicate privilege pairs", async () => {
    const value = await fixture();
    const instruction = cloneInstruction(value.stake);
    (instruction.accounts as { address: string; role: 0 | 1 | 2 | 3 }[])[1].address =
      value.context.glamVaultAddress;
    await expect(
      mapper.mapKaminoFarmsStakeOperationNeutral(
        { ...value.input, instructions: [instruction] },
        value.context,
      ),
    ).resolves.toMatchObject({
      kind: "unsupported",
      reason: "operation-binding",
      instructionIndex: 0,
    });
  });

  it("rejects missing, extra, and reordered first-stake output atomically", async () => {
    const value = await fixture("initializeAndStake");
    for (const instructions of [
      [value.stake],
      [value.stake, value.initialize!],
      [value.initialize!, value.stake, value.stake],
    ]) {
      const result = await mapper.mapKaminoFarmsStakeOperationNeutral(
        { ...value.input, instructions },
        value.context,
      );
      expect(result.kind).toBe("unsupported");
      expect("instructions" in result).toBe(false);
    }
  });

  it("snapshots mutable context and input before async derivation", async () => {
    const value = await fixture();
    const mutableContext = {
      ...value.context,
      integrationAuthorityByProxyProgram: {
        ...value.context.integrationAuthorityByProxyProgram,
      },
    };
    const mutableInput = {
      ...value.input,
      instructions: value.input.instructions.map(cloneInstruction),
      reviewedContext: { ...value.input.reviewedContext },
    };
    const hostileEnvironment: NeutralMapperEnvironment = {
      ...environment,
      async deriveAssociatedTokenAddress(input) {
        mutableContext.glamVaultAddress = PublicKey.unique().toBase58();
        mutableInput.reviewedContext.farmStateAddress = PublicKey.unique().toBase58();
        (mutableInput.instructions[0].accounts as { address: string; role: number }[])[0].address =
          PublicKey.unique().toBase58();
        return environment.deriveAssociatedTokenAddress!(input);
      },
    };
    const hostileMapper = createNeutralMapper(hostileEnvironment);
    const result = await hostileMapper.mapKaminoFarmsStakeOperationNeutral(
      mutableInput,
      mutableContext,
    );
    expect(result.kind).toBe("mappedOperation");
  });

  it("fails closed without both deterministic derivation bindings", async () => {
    const value = await fixture();
    for (const missing of ["deriveProgramAddress", "deriveAssociatedTokenAddress"] as const) {
      const partial = { ...environment };
      delete partial[missing];
      await expect(
        createNeutralMapper(partial).mapKaminoFarmsStakeOperationNeutral(
          value.input,
          value.context,
        ),
      ).resolves.toMatchObject({ kind: "unsupported", reason: "operation-binding" });
    }
  });

  describe("allowed duplicate privilege pair schema", () => {
    function config() {
      return structuredClone(FarmsStrictConfig) as never;
    }

    function validate(value: never) {
      return validateStrictRemappingConfigs(
        { [FARMS.toBase58()]: value },
        environment,
      );
    }

    it("accepts only reviewed forward same_as pairs", () => {
      expect(() => validate(config())).not.toThrow();
      const cases = [
        [{ index: 0, same_as: 1 }],
        [{ index: 1, same_as: 0 }, { index: 1, same_as: 0 }],
        [{ index: 7, same_as: 0 }],
        [{ index: 1, same_as: 0, unknown: true }],
      ];
      for (const pairs of cases) {
        const value = config() as typeof FarmsStrictConfig;
        value.instructions[0].strict.allowed_duplicate_privilege_pairs =
          pairs as never;
        expect(() => validate(value as never)).toThrow();
      }
    });

    it("rejects a pair unless the fixed identity carries the same_as constraint", () => {
      const value = config() as typeof FarmsStrictConfig;
      delete value.instructions[0].strict.fixed_accounts[1].same_as;
      expect(() => validate(value as never)).toThrow(/same_as/);
    });
  });

  it("rejects runtime profile drift from the attested snapshot bound", () => {
    const profile = structuredClone(FarmsOperationProfiles);
    profile.operations[0].maximum_snapshot_age_slots = 21 as never;
    const configs = validateStrictRemappingConfigs(
      { [FARMS.toBase58()]: structuredClone(FarmsStrictConfig) as never },
      environment,
    );
    expect(() =>
      validateFarmsOperationProfileConfig(profile as never, configs, environment),
    ).toThrow(/profile contract changed/);
  });
});
