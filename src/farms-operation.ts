import type {
  InstructionClassificationConfig,
  KaminoFarmsStakeContext,
  MapKaminoFarmsStakeOperationInput,
  NeutralInstruction,
  NeutralMapOperationResult,
  NeutralMapperEnvironment,
  NeutralMappingContext,
  StrictRemappingConfigs,
  UnsupportedInstructionReason,
  UnsupportedOperationResult,
} from "./core-types";
import {
  bytesEqual,
  normalizeAddress,
  normalizeInstructionNeutral,
} from "./neutral";
import { mapInstructionWithConfigs } from "./strict";

interface FarmsSdkTuple {
  readonly package: "@kamino-finance/farms-sdk";
  readonly version: "3.2.26";
  readonly native_idl_version: "1.6.5";
  readonly npm_integrity: string;
  readonly tarball_sha256: string;
  readonly solana_kit_version: "2.3.0";
  readonly source_hashes: Readonly<Record<string, string>>;
}

interface FarmsProfileStep {
  readonly position: number;
  readonly outcome: "mapped";
  readonly source_instruction: "initialize_user" | "stake";
  readonly account_bindings: readonly {
    readonly index: number;
    readonly role: 0 | 1 | 2 | 3;
    readonly binding: string;
  }[];
}

interface FarmsProfile {
  readonly id:
    | "farms.existing-user-classic-spl-stake"
    | "farms.first-stake-classic-spl";
  readonly operation: "stake" | "initializeAndStake";
  readonly official_emitter:
    | "Farms.stakeIx"
    | "Farms.createNewUserIx + Farms.stakeIx";
  readonly bounded_binding: string;
  readonly user_state: "existing" | "absent";
  readonly atomic: true;
  readonly maximum_snapshot_age_slots: 20;
  readonly amount: "positive-finite-u64";
  readonly farms_program: string;
  readonly token_program: string;
  readonly associated_token_program: string;
  readonly scope_prices: "none-program-sentinel";
  readonly sequence: readonly FarmsProfileStep[];
}

interface FarmsOperationProfileConfig {
  readonly $schema?: string;
  readonly schema_version: 2;
  readonly config_revision: 1;
  readonly integration: "kamino-farms-stake";
  readonly official_sdk_tuple: FarmsSdkTuple;
  readonly operations: readonly FarmsProfile[];
}

interface NormalizedFarmsContext extends KaminoFarmsStakeContext {}

const FARMS_PROGRAM = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
const U64_MAX = (1n << 64n) - 1n;

function unsupported(
  reason: UnsupportedInstructionReason,
  message: string,
  instructionIndex: number | null,
): UnsupportedOperationResult {
  return { kind: "unsupported", reason, message, instructionIndex };
}

function requireObject<T>(value: T, label: string): asserts value is T & object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownKeys(value: object, allowed: readonly string[], label: string) {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} has unknown field "${unknown.sort()[0]}"`);
  }
}

function snapshotMappingContext(
  context: NeutralMappingContext,
  environment: NeutralMapperEnvironment,
): NeutralMappingContext {
  requireObject(context, "Farms mapping context");
  const authorities: Record<string, string> = {};
  for (const [program, authority] of Object.entries(
    context.integrationAuthorityByProxyProgram ?? {},
  )) {
    authorities[normalizeAddress(program, "proxy program", environment)] =
      normalizeAddress(authority, "integration authority", environment);
  }
  return Object.freeze({
    glamStateAddress: normalizeAddress(
      context.glamStateAddress,
      "GLAM state",
      environment,
    ),
    glamVaultAddress: normalizeAddress(
      context.glamVaultAddress,
      "GLAM vault",
      environment,
    ),
    glamSignerAddress: normalizeAddress(
      context.glamSignerAddress,
      "GLAM signer",
      environment,
    ),
    integrationAuthorityByProxyProgram: Object.freeze(authorities),
  });
}

function normalizeSlot(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${label} must be a non-negative bigint`);
  }
  return value;
}

function normalizeReviewedContext(
  context: KaminoFarmsStakeContext,
  operation: FarmsProfile,
  environment: NeutralMapperEnvironment,
): NormalizedFarmsContext {
  requireObject(context, "Farms reviewed context");
  assertKnownKeys(
    context,
    [
      "stateObservationSlot",
      "currentSlot",
      "userStateExists",
      "sourceAtaExists",
      "isFarmDelegated",
      "isObligationFarm",
      "farmStateAddress",
      "stakeMintAddress",
      "farmVaultAddress",
      "userStateAddress",
      "userSourceAtaAddress",
      "farmTokenProgramAddress",
      "farmScopePricesAddress",
    ],
    "Farms reviewed context",
  );
  const stateObservationSlot = normalizeSlot(
    context.stateObservationSlot,
    "Farms state observation slot",
  );
  const currentSlot = normalizeSlot(context.currentSlot, "Farms current slot");
  if (
    currentSlot < stateObservationSlot ||
    currentSlot - stateObservationSlot >
      BigInt(operation.maximum_snapshot_age_slots)
  ) {
    throw new TypeError("Farms decoded state snapshot is stale or from the future");
  }
  if (
    context.sourceAtaExists !== true ||
    context.isFarmDelegated !== false ||
    context.isObligationFarm !== false ||
    context.userStateExists !== (operation.user_state === "existing")
  ) {
    throw new TypeError(
      "Farms stake requires an existing source ATA, a direct non-delegated farm, and the selected user-state branch",
    );
  }
  const normalize = (value: unknown, label: string) =>
    normalizeAddress(value, label, environment);
  const farmTokenProgramAddress = normalize(
    context.farmTokenProgramAddress,
    "Farms decoded token program",
  );
  const farmScopePricesAddress = normalize(
    context.farmScopePricesAddress,
    "Farms decoded Scope prices",
  );
  if (
    farmTokenProgramAddress !== TOKEN_PROGRAM ||
    farmScopePricesAddress !== SYSTEM_PROGRAM
  ) {
    throw new TypeError(
      "Farms stake requires classic SPL Token and decoded FarmState.scopePrices=default()",
    );
  }
  return Object.freeze({
    stateObservationSlot,
    currentSlot,
    userStateExists: context.userStateExists,
    sourceAtaExists: true,
    isFarmDelegated: false,
    isObligationFarm: false,
    farmStateAddress: normalize(context.farmStateAddress, "Farms state"),
    stakeMintAddress: normalize(context.stakeMintAddress, "Farms stake mint"),
    farmVaultAddress: normalize(context.farmVaultAddress, "Farms vault"),
    userStateAddress: normalize(context.userStateAddress, "Farms user state"),
    userSourceAtaAddress: normalize(
      context.userSourceAtaAddress,
      "Farms user source ATA",
    ),
    farmTokenProgramAddress,
    farmScopePricesAddress,
  });
}

function assertStep(
  step: FarmsProfileStep,
  expected: {
    readonly position: number;
    readonly source: "initialize_user" | "stake";
    readonly roles: readonly number[];
    readonly bindings: readonly string[];
  },
) {
  if (
    step.position !== expected.position ||
    step.outcome !== "mapped" ||
    step.source_instruction !== expected.source ||
    step.account_bindings.length !== 8 ||
    step.account_bindings.some(
      (account, index) =>
        account.index !== index ||
        account.role !== expected.roles[index] ||
        account.binding !== expected.bindings[index] ||
        Object.keys(account).length !== 3,
    )
  ) {
    throw new TypeError(`Farms ${expected.source} profile step drifted`);
  }
}

function validateFarmsOperationProfileConfig(
  input: FarmsOperationProfileConfig,
  configs: StrictRemappingConfigs,
  environment: NeutralMapperEnvironment,
): FarmsOperationProfileConfig {
  requireObject(input, "Farms operation profile");
  assertKnownKeys(
    input,
    ["$schema", "schema_version", "config_revision", "integration", "official_sdk_tuple", "operations"],
    "Farms operation profile",
  );
  const tuple = input.official_sdk_tuple;
  requireObject(tuple, "Farms SDK tuple");
  assertKnownKeys(
    tuple,
    ["package", "version", "native_idl_version", "npm_integrity", "tarball_sha256", "solana_kit_version", "source_hashes"],
    "Farms SDK tuple",
  );
  if (
    input.schema_version !== 2 ||
    input.config_revision !== 1 ||
    input.integration !== "kamino-farms-stake" ||
    tuple.package !== "@kamino-finance/farms-sdk" ||
    tuple.version !== "3.2.26" ||
    tuple.native_idl_version !== "1.6.5" ||
    tuple.solana_kit_version !== "2.3.0" ||
    tuple.tarball_sha256 !== "21155adcc0d05a12f68e203547c983373adbe29bbbb098b249e9eaf4a75633bb" ||
    !tuple.npm_integrity.startsWith("sha512-")
  ) {
    throw new TypeError("Farms SDK tuple is not the reviewed 3.2.26/IDL 1.6.5 tuple");
  }
  const hashes = tuple.source_hashes;
  requireObject(hashes, "Farms SDK source hashes");
  const hashKeys = ["farms_client", "operations", "pda_helpers", "initialize_user_builder", "stake_builder"];
  assertKnownKeys(hashes, hashKeys, "Farms SDK source hashes");
  if (
    hashKeys.some(
      (key) => !/^[0-9a-f]{64}$/.test((hashes as Record<string, string>)[key] ?? ""),
    )
  ) {
    throw new TypeError("Farms SDK source hash is malformed");
  }
  if (!Array.isArray(input.operations) || input.operations.length !== 2) {
    throw new TypeError("Farms profile must contain exactly two operations");
  }
  const byOperation = new Map(input.operations.map((profile) => [profile.operation, profile]));
  const existing = byOperation.get("stake");
  const first = byOperation.get("initializeAndStake");
  if (!existing || !first || byOperation.size !== 2) {
    throw new TypeError("Farms profile operations changed");
  }
  for (const profile of [existing, first]) {
    requireObject(profile, "Farms stake profile");
    assertKnownKeys(
      profile,
      ["id", "operation", "official_emitter", "bounded_binding", "user_state", "atomic", "maximum_snapshot_age_slots", "amount", "farms_program", "token_program", "associated_token_program", "scope_prices", "sequence"],
      "Farms stake profile",
    );
    if (
      profile.atomic !== true ||
      profile.maximum_snapshot_age_slots !== 20 ||
      profile.amount !== "positive-finite-u64" ||
      profile.bounded_binding !== "pinned decoded farm state plus immutable official helper output" ||
      normalizeAddress(profile.farms_program, "Farms program", environment) !== FARMS_PROGRAM ||
      normalizeAddress(profile.token_program, "Farms token program", environment) !== TOKEN_PROGRAM ||
      normalizeAddress(profile.associated_token_program, "Farms ATA program", environment) !== ASSOCIATED_TOKEN_PROGRAM ||
      profile.scope_prices !== "none-program-sentinel"
    ) {
      throw new TypeError("Farms stake profile contract changed");
    }
  }
  if (
    existing.id !== "farms.existing-user-classic-spl-stake" ||
    existing.official_emitter !== "Farms.stakeIx" ||
    existing.user_state !== "existing" ||
    existing.sequence.length !== 1 ||
    first.id !== "farms.first-stake-classic-spl" ||
    first.official_emitter !== "Farms.createNewUserIx + Farms.stakeIx" ||
    first.user_state !== "absent" ||
    first.sequence.length !== 2
  ) {
    throw new TypeError("Farms stake branch contract changed");
  }
  const stakeRoles = [2, 1, 1, 1, 1, 0, 0, 0] as const;
  const stakeBindings = [
    "glam_vault",
    "derived_user_state_pda",
    "farm_state",
    "derived_farm_vault_pda",
    "derived_source_ata",
    "stake_mint",
    "farms_program_optional_sentinel",
    "classic_spl_token_program",
  ] as const;
  const initRoles = [2, 3, 0, 0, 1, 1, 0, 0] as const;
  const initBindings = [
    "glam_vault",
    "glam_vault",
    "glam_vault",
    "glam_vault",
    "derived_user_state_pda",
    "farm_state",
    "system_program",
    "rent_sysvar",
  ] as const;
  assertStep(existing.sequence[0], { position: 0, source: "stake", roles: stakeRoles, bindings: stakeBindings });
  assertStep(first.sequence[0], { position: 0, source: "initialize_user", roles: initRoles, bindings: initBindings });
  assertStep(first.sequence[1], { position: 1, source: "stake", roles: stakeRoles, bindings: stakeBindings });

  const config = configs[FARMS_PROGRAM];
  if (
    !config ||
    config.instructions.length !== 2 ||
    config.instructions[0].src_ix_name !== "initialize_user" ||
    config.instructions[1].src_ix_name !== "stake"
  ) {
    throw new TypeError("Farms strict mappings do not match the profile");
  }
  return input;
}

function decodePositiveFiniteU64(data: Uint8Array): bigint | undefined {
  if (data.length !== 16) return undefined;
  let amount = 0n;
  for (let index = 0; index < 8; index += 1) {
    amount |= BigInt(data[8 + index]) << BigInt(index * 8);
  }
  return amount > 0n && amount < U64_MAX ? amount : undefined;
}

function exactInstructionFailure(
  instruction: NeutralInstruction,
  expectedData: readonly number[] | "positive-u64",
  expectedAccounts: readonly { readonly address: string; readonly role: 0 | 1 | 2 | 3 }[],
  name: string,
): string | undefined {
  if (instruction.programAddress !== FARMS_PROGRAM) return `${name} has an unexpected program`;
  if (
    expectedData === "positive-u64"
      ? !bytesEqual(instruction.data.subarray(0, 8), new Uint8Array([206, 176, 202, 18, 200, 209, 179, 108])) || decodePositiveFiniteU64(instruction.data) === undefined
      : !bytesEqual(instruction.data, new Uint8Array(expectedData))
  ) {
    return `${name} data changed`;
  }
  if (instruction.accounts.length !== expectedAccounts.length) {
    return `${name} has an unexpected account count`;
  }
  for (let index = 0; index < expectedAccounts.length; index += 1) {
    if (
      instruction.accounts[index].address !== expectedAccounts[index].address ||
      instruction.accounts[index].role !== expectedAccounts[index].role
    ) {
      return `${name} account ${String(index)} changed`;
    }
  }
  return undefined;
}

async function mapKaminoFarmsStakeOperationWithConfigs(
  input: MapKaminoFarmsStakeOperationInput,
  context: NeutralMappingContext,
  configs: StrictRemappingConfigs,
  classifications: InstructionClassificationConfig,
  profiles: FarmsOperationProfileConfig,
  environment: NeutralMapperEnvironment,
): Promise<NeutralMapOperationResult> {
  let profile: FarmsProfile;
  let reviewed: NormalizedFarmsContext;
  let instructions: readonly NeutralInstruction[];
  let snapshot: NeutralMappingContext;
  try {
    requireObject(input, "Farms stake operation input");
    assertKnownKeys(input, ["operation", "officialSdkVersion", "instructions", "reviewedContext"], "Farms stake operation input");
    if (input.officialSdkVersion !== profiles.official_sdk_tuple.version) {
      throw new TypeError("Farms official SDK tuple is not reviewed");
    }
    profile = profiles.operations.find(({ operation }) => operation === input.operation) as FarmsProfile;
    if (!profile) throw new TypeError("Farms operation is not reviewed");
    reviewed = normalizeReviewedContext(input.reviewedContext, profile, environment);
    snapshot = snapshotMappingContext(context, environment);
    if (!Array.isArray(input.instructions) || input.instructions.length !== profile.sequence.length) {
      throw new TypeError(`Farms ${profile.operation} requires exactly ${String(profile.sequence.length)} instruction(s)`);
    }
    instructions = Object.freeze(
      input.instructions.map((instruction) =>
        normalizeInstructionNeutral(instruction, environment),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported("operation-shape", `Farms stake operation could not be normalized safely: ${message}`, null);
  }

  if (
    typeof environment.deriveAssociatedTokenAddress !== "function" ||
    typeof environment.deriveProgramAddress !== "function"
  ) {
    return unsupported("operation-binding", "Farms stake requires ATA and PDA derivation bindings", null);
  }
  let derivedUserState: string;
  let derivedFarmVault: string;
  let derivedSourceAta: string;
  try {
    const [userState, farmVault, sourceAta] = await Promise.all([
      environment.deriveProgramAddress({
        programAddress: FARMS_PROGRAM,
        seeds: [
          { kind: "utf8", value: "user" },
          { kind: "address", value: reviewed.farmStateAddress },
          { kind: "address", value: snapshot.glamVaultAddress },
        ],
      }),
      environment.deriveProgramAddress({
        programAddress: FARMS_PROGRAM,
        seeds: [
          { kind: "utf8", value: "fvault" },
          { kind: "address", value: reviewed.farmStateAddress },
          { kind: "address", value: reviewed.stakeMintAddress },
        ],
      }),
      environment.deriveAssociatedTokenAddress({
        ownerAddress: snapshot.glamVaultAddress,
        mintAddress: reviewed.stakeMintAddress,
        tokenProgramAddress: TOKEN_PROGRAM,
        associatedTokenProgramAddress: ASSOCIATED_TOKEN_PROGRAM,
      }),
    ]);
    derivedUserState = normalizeAddress(userState, "derived Farms user state", environment);
    derivedFarmVault = normalizeAddress(farmVault, "derived Farms vault", environment);
    derivedSourceAta = normalizeAddress(sourceAta, "derived Farms source ATA", environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported("operation-binding", `Farms stake derivation failed: ${message}`, null);
  }
  if (
    derivedUserState !== reviewed.userStateAddress ||
    derivedFarmVault !== reviewed.farmVaultAddress ||
    derivedSourceAta !== reviewed.userSourceAtaAddress
  ) {
    return unsupported("operation-binding", "Farms decoded state does not match canonical PDA/ATA relationships", null);
  }

  const initAccounts = [
    { address: snapshot.glamVaultAddress, role: 2 as const },
    { address: snapshot.glamVaultAddress, role: 3 as const },
    { address: snapshot.glamVaultAddress, role: 0 as const },
    { address: snapshot.glamVaultAddress, role: 0 as const },
    { address: derivedUserState, role: 1 as const },
    { address: reviewed.farmStateAddress, role: 1 as const },
    { address: SYSTEM_PROGRAM, role: 0 as const },
    { address: RENT_SYSVAR, role: 0 as const },
  ];
  const stakeAccounts = [
    { address: snapshot.glamVaultAddress, role: 2 as const },
    { address: derivedUserState, role: 1 as const },
    { address: reviewed.farmStateAddress, role: 1 as const },
    { address: derivedFarmVault, role: 1 as const },
    { address: derivedSourceAta, role: 1 as const },
    { address: reviewed.stakeMintAddress, role: 0 as const },
    { address: FARMS_PROGRAM, role: 0 as const },
    { address: TOKEN_PROGRAM, role: 0 as const },
  ];

  const output = [] as Exclude<NeutralMapOperationResult, UnsupportedOperationResult>["instructions"][number][];
  for (let index = 0; index < profile.sequence.length; index += 1) {
    const step = profile.sequence[index];
    const instruction = instructions[index];
    const failure =
      step.source_instruction === "initialize_user"
        ? exactInstructionFailure(instruction, [111, 17, 185, 250, 60, 122, 38, 254], initAccounts, "Farms initialize_user")
        : exactInstructionFailure(instruction, "positive-u64", stakeAccounts, "Farms stake");
    if (failure) return unsupported("operation-binding", failure, index);
    const mapped = mapInstructionWithConfigs(
      instruction,
      snapshot,
      configs,
      classifications,
      environment,
    );
    if (mapped.kind !== "mapped") {
      return mapped.kind === "unsupported"
        ? unsupported(mapped.reason, mapped.message, index)
        : unsupported(
            "destination-invariant",
            "Farms stake profile cannot contain native passthrough",
            index,
          );
    }
    output.push(mapped);
  }
  return Object.freeze({
    kind: "mappedOperation",
    operation: profile.operation,
    instructions: Object.freeze(output),
  });
}

export {
  mapKaminoFarmsStakeOperationWithConfigs,
  validateFarmsOperationProfileConfig,
};
export type { FarmsOperationProfileConfig };
