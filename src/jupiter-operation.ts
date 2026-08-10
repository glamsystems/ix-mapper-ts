import type {
  InstructionClassificationConfig,
  JupiterEarnExternalProfile,
  JupiterEarnReviewedContext,
  MapJupiterEarnOperationInput,
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

interface JupiterSdkTuple {
  readonly package: "@jup-ag/lend";
  readonly version: "0.1.10";
  readonly native_idl_version: "0.1.0";
  readonly npm_integrity: string;
  readonly tarball_sha256: string;
  readonly solana_kit_version: "2.3.0";
  readonly source_hashes: Readonly<Record<string, string>>;
}

interface JupiterProfileBinding {
  readonly profile: "jupiter-earn-main-classic-spl-v1";
  readonly market: "main";
  readonly lending_program: string;
  readonly liquidity_program: string;
  readonly asset_token_program: string;
  readonly f_token_program: string;
  readonly associated_token_program: string;
  readonly system_program: string;
  readonly setup: "none";
  readonly base_commit: "4053ffbad104ce7f17505f4b3b85d5b1b414fc37";
  readonly hardening_commit: "356ed8420edc24ceb518d88440f4e17c24378c61";
}

interface JupiterProfileStep {
  readonly position: 0;
  readonly outcome: "mapped";
  readonly source_instruction:
    | "deposit_with_min_amount_out"
    | "redeem_with_min_amount_out";
  readonly account_bindings: readonly {
    readonly index: number;
    readonly role: 0 | 1 | 2 | 3;
    readonly binding: string;
  }[];
}

interface JupiterProfile {
  readonly id:
    | "jupiter-earn.main-classic-spl-deposit-with-min-out"
    | "jupiter-earn.main-classic-spl-redeem-with-min-out";
  readonly operation: "depositWithMinAmountOut" | "redeemWithMinAmountOut";
  readonly official_emitter: string;
  readonly bounded_binding: string;
  readonly external_profile: JupiterProfileBinding;
  readonly atomic: true;
  readonly maximum_snapshot_age_slots: 20;
  readonly amounts:
    | "nonzero-u64-assets-and-min-out"
    | "nonzero-u64-shares-and-min-out";
  readonly requires_existing_atas: true;
  readonly sequence: readonly JupiterProfileStep[];
}

interface JupiterOperationProfileConfig {
  readonly $schema?: string;
  readonly schema_version: 2;
  readonly config_revision: 1;
  readonly integration: "jupiter-earn";
  readonly official_sdk_tuple: JupiterSdkTuple;
  readonly operations: readonly JupiterProfile[];
}

interface NormalizedJupiterContext extends JupiterEarnReviewedContext {}

const LENDING_PROGRAM = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
const LIQUIDITY_PROGRAM = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const BASE_COMMIT = "4053ffbad104ce7f17505f4b3b85d5b1b414fc37";
const HARDENING_COMMIT = "356ed8420edc24ceb518d88440f4e17c24378c61";
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

function assertKnownKeys(
  value: object,
  allowed: readonly string[],
  label: string,
) {
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
  requireObject(context, "Jupiter mapping context");
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

function normalizeExternalProfile(
  value: JupiterEarnExternalProfile,
  environment: NeutralMapperEnvironment,
): Readonly<JupiterEarnExternalProfile> {
  requireObject(value, "Jupiter external profile");
  assertKnownKeys(
    value,
    [
      "profile",
      "market",
      "lendingProgramAddress",
      "liquidityProgramAddress",
      "assetTokenProgramAddress",
      "fTokenProgramAddress",
      "associatedTokenProgramAddress",
      "systemProgramAddress",
      "setup",
      "baseCommit",
      "hardeningCommit",
    ],
    "Jupiter external profile",
  );
  const normalized = Object.freeze({
    profile: value.profile,
    market: value.market,
    lendingProgramAddress: normalizeAddress(
      value.lendingProgramAddress,
      "Jupiter Lending program",
      environment,
    ),
    liquidityProgramAddress: normalizeAddress(
      value.liquidityProgramAddress,
      "Jupiter Liquidity program",
      environment,
    ),
    assetTokenProgramAddress: normalizeAddress(
      value.assetTokenProgramAddress,
      "Jupiter asset token program",
      environment,
    ),
    fTokenProgramAddress: normalizeAddress(
      value.fTokenProgramAddress,
      "Jupiter f-token program",
      environment,
    ),
    associatedTokenProgramAddress: normalizeAddress(
      value.associatedTokenProgramAddress,
      "Jupiter associated-token program",
      environment,
    ),
    systemProgramAddress: normalizeAddress(
      value.systemProgramAddress,
      "Jupiter system program",
      environment,
    ),
    setup: value.setup,
    baseCommit: value.baseCommit,
    hardeningCommit: value.hardeningCommit,
  });
  if (
    normalized.profile !== "jupiter-earn-main-classic-spl-v1" ||
    normalized.market !== "main" ||
    normalized.lendingProgramAddress !== LENDING_PROGRAM ||
    normalized.liquidityProgramAddress !== LIQUIDITY_PROGRAM ||
    normalized.assetTokenProgramAddress !== TOKEN_PROGRAM ||
    normalized.fTokenProgramAddress !== TOKEN_PROGRAM ||
    normalized.associatedTokenProgramAddress !== ASSOCIATED_TOKEN_PROGRAM ||
    normalized.systemProgramAddress !== SYSTEM_PROGRAM ||
    normalized.setup !== "none" ||
    normalized.baseCommit !== BASE_COMMIT ||
    normalized.hardeningCommit !== HARDENING_COMMIT
  ) {
    throw new TypeError("Jupiter external profile is not the reviewed binding");
  }
  return normalized;
}

function normalizeReviewedContext(
  context: JupiterEarnReviewedContext,
  profile: JupiterProfile,
  environment: NeutralMapperEnvironment,
): NormalizedJupiterContext {
  requireObject(context, "Jupiter reviewed context");
  assertKnownKeys(
    context,
    [
      "stateObservationSlot",
      "currentSlot",
      "underlyingAtaExists",
      "fTokenAtaExists",
      "lending",
      "tokenReserve",
    ],
    "Jupiter reviewed context",
  );
  requireObject(context.lending, "Jupiter decoded Lending state");
  requireObject(context.tokenReserve, "Jupiter decoded TokenReserve state");
  assertKnownKeys(
    context.lending,
    [
      "ownerProgramAddress",
      "address",
      "mintAddress",
      "fTokenMintAddress",
      "tokenReservesLiquidityAddress",
      "supplyPositionOnLiquidityAddress",
      "rewardsRateModelAddress",
    ],
    "Jupiter decoded Lending state",
  );
  assertKnownKeys(
    context.tokenReserve,
    ["ownerProgramAddress", "address", "mintAddress", "vaultAddress"],
    "Jupiter decoded TokenReserve state",
  );
  const stateObservationSlot = normalizeSlot(
    context.stateObservationSlot,
    "Jupiter state observation slot",
  );
  const currentSlot = normalizeSlot(context.currentSlot, "Jupiter current slot");
  if (
    currentSlot < stateObservationSlot ||
    currentSlot - stateObservationSlot >
      BigInt(profile.maximum_snapshot_age_slots)
  ) {
    throw new TypeError(
      "Jupiter decoded state snapshot is stale or from the future",
    );
  }
  if (
    context.underlyingAtaExists !== true ||
    context.fTokenAtaExists !== true
  ) {
    throw new TypeError(
      "Jupiter Earn requires existing underlying and f-token ATAs",
    );
  }
  const normalize = (address: unknown, label: string) =>
    normalizeAddress(address, label, environment);
  const lending = Object.freeze({
    ownerProgramAddress: normalize(
      context.lending.ownerProgramAddress,
      "Jupiter Lending state owner",
    ),
    address: normalize(context.lending.address, "Jupiter Lending market"),
    mintAddress: normalize(
      context.lending.mintAddress,
      "Jupiter Lending mint",
    ),
    fTokenMintAddress: normalize(
      context.lending.fTokenMintAddress,
      "Jupiter f-token mint",
    ),
    tokenReservesLiquidityAddress: normalize(
      context.lending.tokenReservesLiquidityAddress,
      "Jupiter token reserve",
    ),
    supplyPositionOnLiquidityAddress: normalize(
      context.lending.supplyPositionOnLiquidityAddress,
      "Jupiter supply position",
    ),
    rewardsRateModelAddress: normalize(
      context.lending.rewardsRateModelAddress,
      "Jupiter rewards rate model",
    ),
  });
  const tokenReserve = Object.freeze({
    ownerProgramAddress: normalize(
      context.tokenReserve.ownerProgramAddress,
      "Jupiter TokenReserve state owner",
    ),
    address: normalize(context.tokenReserve.address, "Jupiter token reserve"),
    mintAddress: normalize(
      context.tokenReserve.mintAddress,
      "Jupiter reserve mint",
    ),
    vaultAddress: normalize(
      context.tokenReserve.vaultAddress,
      "Jupiter reserve vault",
    ),
  });
  if (lending.mintAddress === WRAPPED_SOL_MINT) {
    throw new TypeError("Jupiter wrapped-SOL Earn is outside this profile");
  }
  if (
    lending.ownerProgramAddress !== LENDING_PROGRAM ||
    tokenReserve.ownerProgramAddress !== LIQUIDITY_PROGRAM
  ) {
    throw new TypeError("Jupiter decoded state owner is outside this profile");
  }
  return Object.freeze({
    stateObservationSlot,
    currentSlot,
    underlyingAtaExists: true,
    fTokenAtaExists: true,
    lending,
    tokenReserve,
  });
}

function exactProfileBinding(value: JupiterProfileBinding): boolean {
  return (
    value.profile === "jupiter-earn-main-classic-spl-v1" &&
    value.market === "main" &&
    value.lending_program === LENDING_PROGRAM &&
    value.liquidity_program === LIQUIDITY_PROGRAM &&
    value.asset_token_program === TOKEN_PROGRAM &&
    value.f_token_program === TOKEN_PROGRAM &&
    value.associated_token_program === ASSOCIATED_TOKEN_PROGRAM &&
    value.system_program === SYSTEM_PROGRAM &&
    value.setup === "none" &&
    value.base_commit === BASE_COMMIT &&
    value.hardening_commit === HARDENING_COMMIT &&
    Object.keys(value).length === 11
  );
}

function assertStep(
  step: JupiterProfileStep,
  source: JupiterProfileStep["source_instruction"],
  bindings: readonly string[],
  roles: readonly number[],
) {
  if (
    step.position !== 0 ||
    step.outcome !== "mapped" ||
    step.source_instruction !== source ||
    step.account_bindings.length !== bindings.length ||
    step.account_bindings.some(
      (account, index) =>
        account.index !== index ||
        account.role !== roles[index] ||
        account.binding !== bindings[index] ||
        Object.keys(account).length !== 3,
    )
  ) {
    throw new TypeError(`Jupiter ${source} profile step drifted`);
  }
}

function validateJupiterOperationProfileConfig(
  input: JupiterOperationProfileConfig,
  configs: StrictRemappingConfigs,
  environment: NeutralMapperEnvironment,
): JupiterOperationProfileConfig {
  requireObject(input, "Jupiter operation profile");
  assertKnownKeys(
    input,
    [
      "$schema",
      "schema_version",
      "config_revision",
      "integration",
      "official_sdk_tuple",
      "operations",
    ],
    "Jupiter operation profile",
  );
  const tuple = input.official_sdk_tuple;
  requireObject(tuple, "Jupiter SDK tuple");
  assertKnownKeys(
    tuple,
    [
      "package",
      "version",
      "native_idl_version",
      "npm_integrity",
      "tarball_sha256",
      "solana_kit_version",
      "source_hashes",
    ],
    "Jupiter SDK tuple",
  );
  if (
    input.schema_version !== 2 ||
    input.config_revision !== 1 ||
    input.integration !== "jupiter-earn" ||
    tuple.package !== "@jup-ag/lend" ||
    tuple.version !== "0.1.10" ||
    tuple.native_idl_version !== "0.1.0" ||
    tuple.solana_kit_version !== "2.3.0" ||
    tuple.tarball_sha256 !==
      "fd84fefecc1a517ddfae64b2b61d293e2cbc854a84c7836181a42dcdec6f5810" ||
    !tuple.npm_integrity.startsWith("sha512-")
  ) {
    throw new TypeError(
      "Jupiter SDK tuple is not the reviewed 0.1.10/IDL 0.1.0 tuple",
    );
  }
  const hashes = tuple.source_hashes;
  requireObject(hashes, "Jupiter source hashes");
  const expectedHashes = {
    official_earn_entry:
      "3f0d9bfc18a999c21dfd02177bab855e367626776e8b70bd436911d9107f4a62",
    native_idl:
      "ef547c925d93149437ffa7cd6be91f7bf3d97a95960c219227b0da91cadb9bd0",
    portable_binding:
      "a440e2daad52f343686154e4ad4092f99a996a80e68f661cb1d87564bd470186",
    operation_vectors:
      "08503390a2f235cad434022ffbe4e38791c704eed0bfec2dca20030e30b159b0",
    portable_instructions:
      "a522235f4d286a7cda8bc22999a79a4b7b435e3e34ac1e6425c3ed082d57c671",
    portable_enumeration:
      "61e144e9c8a7223b5915e5dfb37f015375eed4a0a25a5966e984c1fa8bc3add3",
    portable_structural:
      "2ff1b89c085621de4447f5aaac6f88180d84350f694ce84f1f5e09f1eef9e238",
    portable_differential:
      "41081bb0df2a5b94c687229294369d15024e4c6f364b32860ae1af3b869f6cd1",
  };
  assertKnownKeys(hashes, Object.keys(expectedHashes), "Jupiter source hashes");
  if (
    Object.entries(expectedHashes).some(
      ([name, hash]) => hashes[name] !== hash,
    )
  ) {
    throw new TypeError("Jupiter source hashes drifted");
  }
  if (!Array.isArray(input.operations) || input.operations.length !== 2) {
    throw new TypeError("Jupiter profile must contain exactly two operations");
  }
  const byOperation = new Map(
    input.operations.map((profile) => [profile.operation, profile]),
  );
  const deposit = byOperation.get("depositWithMinAmountOut");
  const redeem = byOperation.get("redeemWithMinAmountOut");
  if (!deposit || !redeem || byOperation.size !== 2) {
    throw new TypeError("Jupiter profile operations changed");
  }

  for (const profile of [deposit, redeem]) {
    requireObject(profile, "Jupiter operation");
    assertKnownKeys(
      profile,
      [
        "id",
        "operation",
        "official_emitter",
        "bounded_binding",
        "external_profile",
        "atomic",
        "maximum_snapshot_age_slots",
        "amounts",
        "requires_existing_atas",
        "sequence",
      ],
      "Jupiter operation",
    );
    requireObject(profile.external_profile, "Jupiter external profile binding");
    if (
      !exactProfileBinding(profile.external_profile) ||
      profile.atomic !== true ||
      profile.maximum_snapshot_age_slots !== 20 ||
      profile.requires_existing_atas !== true ||
      profile.bounded_binding !==
        "pinned decoded Lending/TokenReserve state plus immutable jupiter-earn-main-classic-spl-v1 output" ||
      profile.sequence.length !== 1
    ) {
      throw new TypeError("Jupiter operation profile contract changed");
    }
  }
  if (
    deposit.id !==
      "jupiter-earn.main-classic-spl-deposit-with-min-out" ||
    deposit.official_emitter !==
      "@jup-ag/lend Program.methods.depositWithMinAmountOut + bounded portable binding" ||
    deposit.amounts !== "nonzero-u64-assets-and-min-out" ||
    redeem.id !== "jupiter-earn.main-classic-spl-redeem-with-min-out" ||
    redeem.official_emitter !==
      "@jup-ag/lend Program.methods.redeemWithMinAmountOut + bounded portable binding" ||
    redeem.amounts !== "nonzero-u64-shares-and-min-out"
  ) {
    throw new TypeError("Jupiter operation branch contract changed");
  }

  assertStep(
    deposit.sequence[0],
    "deposit_with_min_amount_out",
    [
      "glam_vault",
      "derived_underlying_ata",
      "derived_f_token_ata",
      "underlying_mint",
      "derived_lending_admin",
      "derived_main_lending_market",
      "derived_f_token_mint",
      "decoded_token_reserve",
      "decoded_supply_position",
      "derived_rate_model",
      "decoded_reserve_vault",
      "derived_liquidity",
      "liquidity_program",
      "decoded_rewards_rate_model",
      "classic_spl_token_program",
      "associated_token_program",
      "system_program",
    ],
    [3, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0],
  );
  assertStep(
    redeem.sequence[0],
    "redeem_with_min_amount_out",
    [
      "glam_vault",
      "derived_f_token_ata",
      "derived_underlying_ata",
      "derived_lending_admin",
      "derived_main_lending_market",
      "underlying_mint",
      "derived_f_token_mint",
      "decoded_token_reserve",
      "decoded_supply_position",
      "derived_rate_model",
      "decoded_reserve_vault",
      "derived_claim_account",
      "derived_liquidity",
      "liquidity_program",
      "decoded_rewards_rate_model",
      "classic_spl_token_program",
      "associated_token_program",
      "system_program",
    ],
    [3, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0],
  );
  const config = configs[LENDING_PROGRAM];
  if (
    !config ||
    config.instructions.length !== 2 ||
    config.instructions[0].src_ix_name !== "deposit_with_min_amount_out" ||
    config.instructions[1].src_ix_name !== "redeem_with_min_amount_out"
  ) {
    throw new TypeError("Jupiter strict mappings do not match the profile");
  }
  return input;
}

function decodeNonzeroU64Pair(data: Uint8Array): boolean {
  if (data.length !== 24) return false;
  const decode = (offset: number) => {
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(data[offset + index]) << BigInt(index * 8);
    }
    return value;
  };
  const first = decode(8);
  const second = decode(16);
  return first > 0n && first <= U64_MAX && second > 0n && second <= U64_MAX;
}

function exactInstructionFailure(
  instruction: NeutralInstruction,
  discriminator: readonly number[],
  expectedAccounts: readonly {
    readonly address: string;
    readonly role: 0 | 1 | 2 | 3;
  }[],
): string | undefined {
  if (instruction.programAddress !== LENDING_PROGRAM) {
    return "Jupiter Earn instruction has an unexpected program";
  }
  if (
    !bytesEqual(
      instruction.data.subarray(0, discriminator.length),
      new Uint8Array(discriminator),
    ) ||
    !decodeNonzeroU64Pair(instruction.data)
  ) {
    return "Jupiter Earn instruction data changed";
  }
  if (instruction.accounts.length !== expectedAccounts.length) {
    return "Jupiter Earn instruction has an unexpected account count";
  }
  for (let index = 0; index < expectedAccounts.length; index += 1) {
    if (
      instruction.accounts[index].address !== expectedAccounts[index].address ||
      instruction.accounts[index].role !== expectedAccounts[index].role
    ) {
      return `Jupiter Earn account ${String(index)} changed`;
    }
  }
  return undefined;
}

async function mapJupiterEarnOperationWithConfigs(
  input: MapJupiterEarnOperationInput,
  context: NeutralMappingContext,
  configs: StrictRemappingConfigs,
  classifications: InstructionClassificationConfig,
  profiles: JupiterOperationProfileConfig,
  environment: NeutralMapperEnvironment,
): Promise<NeutralMapOperationResult> {
  let profile: JupiterProfile;
  let externalProfile: Readonly<JupiterEarnExternalProfile>;
  let reviewed: NormalizedJupiterContext;
  let instruction: NeutralInstruction;
  let snapshot: NeutralMappingContext;
  try {
    requireObject(input, "Jupiter Earn operation input");
    assertKnownKeys(
      input,
      [
        "operation",
        "officialSdkVersion",
        "externalProfile",
        "instructions",
        "reviewedContext",
      ],
      "Jupiter Earn operation input",
    );
    if (input.officialSdkVersion !== profiles.official_sdk_tuple.version) {
      throw new TypeError("Jupiter official SDK tuple is not reviewed");
    }
    profile = profiles.operations.find(
      ({ operation }) => operation === input.operation,
    ) as JupiterProfile;
    if (!profile) throw new TypeError("Jupiter Earn operation is not reviewed");
    externalProfile = normalizeExternalProfile(input.externalProfile, environment);
    reviewed = normalizeReviewedContext(
      input.reviewedContext,
      profile,
      environment,
    );
    snapshot = snapshotMappingContext(context, environment);
    if (!Array.isArray(input.instructions) || input.instructions.length !== 1) {
      throw new TypeError(
        `Jupiter ${profile.operation} requires exactly one instruction`,
      );
    }
    instruction = normalizeInstructionNeutral(input.instructions[0], environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "operation-shape",
      `Jupiter Earn operation could not be normalized safely: ${message}`,
      null,
    );
  }

  if (
    typeof environment.deriveAssociatedTokenAddress !== "function" ||
    typeof environment.deriveProgramAddress !== "function"
  ) {
    return unsupported(
      "operation-binding",
      "Jupiter Earn requires ATA and PDA derivation bindings",
      null,
    );
  }

  let underlyingAta: string;
  let fTokenAta: string;
  let lendingAdmin: string;
  let fTokenMint: string;
  let lendingMarket: string;
  let liquidity: string;
  let rateModel: string;
  let claimAccount: string;
  try {
    const derived = await Promise.all([
      environment.deriveAssociatedTokenAddress({
        ownerAddress: snapshot.glamVaultAddress,
        mintAddress: reviewed.lending.mintAddress,
        tokenProgramAddress: externalProfile.assetTokenProgramAddress,
        associatedTokenProgramAddress:
          externalProfile.associatedTokenProgramAddress,
      }),
      environment.deriveAssociatedTokenAddress({
        ownerAddress: snapshot.glamVaultAddress,
        mintAddress: reviewed.lending.fTokenMintAddress,
        tokenProgramAddress: externalProfile.fTokenProgramAddress,
        associatedTokenProgramAddress:
          externalProfile.associatedTokenProgramAddress,
      }),
      environment.deriveProgramAddress({
        programAddress: LENDING_PROGRAM,
        seeds: [{ kind: "utf8", value: "lending_admin" }],
      }),
      environment.deriveProgramAddress({
        programAddress: LENDING_PROGRAM,
        seeds: [
          { kind: "utf8", value: "f_token_mint" },
          { kind: "address", value: reviewed.lending.mintAddress },
        ],
      }),
      environment.deriveProgramAddress({
        programAddress: LENDING_PROGRAM,
        seeds: [
          { kind: "utf8", value: "lending" },
          { kind: "address", value: reviewed.lending.mintAddress },
          { kind: "address", value: reviewed.lending.fTokenMintAddress },
        ],
      }),
      environment.deriveProgramAddress({
        programAddress: LIQUIDITY_PROGRAM,
        seeds: [{ kind: "utf8", value: "liquidity" }],
      }),
      environment.deriveProgramAddress({
        programAddress: LIQUIDITY_PROGRAM,
        seeds: [
          { kind: "utf8", value: "rate_model" },
          { kind: "address", value: reviewed.lending.mintAddress },
        ],
      }),
    ]);
    [
      underlyingAta,
      fTokenAta,
      lendingAdmin,
      fTokenMint,
      lendingMarket,
      liquidity,
      rateModel,
    ] = derived.map((address) =>
      normalizeAddress(address, "derived Jupiter address", environment),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "operation-binding",
      `Jupiter Earn derivation failed: ${message}`,
      null,
    );
  }

  // The claim PDA uses the Lending admin as its owner. It cannot be included in
  // the parallel derivation above until the admin result is known.
  try {
    claimAccount = normalizeAddress(
      await environment.deriveProgramAddress({
        programAddress: LIQUIDITY_PROGRAM,
        seeds: [
          { kind: "utf8", value: "user_claim" },
          { kind: "address", value: lendingAdmin },
          { kind: "address", value: reviewed.lending.mintAddress },
        ],
      }),
      "derived Jupiter claim account",
      environment,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "operation-binding",
      `Jupiter Earn claim derivation failed: ${message}`,
      null,
    );
  }

  if (
    reviewed.lending.fTokenMintAddress !== fTokenMint ||
    reviewed.lending.address !== lendingMarket ||
    reviewed.tokenReserve.address !==
      reviewed.lending.tokenReservesLiquidityAddress ||
    reviewed.tokenReserve.mintAddress !== reviewed.lending.mintAddress
  ) {
    return unsupported(
      "operation-binding",
      "Jupiter decoded Lending/TokenReserve relationships changed",
      null,
    );
  }

  const depositAccounts = [
    { address: snapshot.glamVaultAddress, role: 3 as const },
    { address: underlyingAta, role: 1 as const },
    { address: fTokenAta, role: 1 as const },
    { address: reviewed.lending.mintAddress, role: 0 as const },
    { address: lendingAdmin, role: 0 as const },
    { address: lendingMarket, role: 1 as const },
    { address: fTokenMint, role: 1 as const },
    {
      address: reviewed.lending.tokenReservesLiquidityAddress,
      role: 1 as const,
    },
    {
      address: reviewed.lending.supplyPositionOnLiquidityAddress,
      role: 1 as const,
    },
    { address: rateModel, role: 0 as const },
    { address: reviewed.tokenReserve.vaultAddress, role: 1 as const },
    { address: liquidity, role: 1 as const },
    { address: LIQUIDITY_PROGRAM, role: 1 as const },
    { address: reviewed.lending.rewardsRateModelAddress, role: 0 as const },
    { address: TOKEN_PROGRAM, role: 0 as const },
    { address: ASSOCIATED_TOKEN_PROGRAM, role: 0 as const },
    { address: SYSTEM_PROGRAM, role: 0 as const },
  ];
  const redeemAccounts = [
    { address: snapshot.glamVaultAddress, role: 3 as const },
    { address: fTokenAta, role: 1 as const },
    { address: underlyingAta, role: 1 as const },
    { address: lendingAdmin, role: 0 as const },
    { address: lendingMarket, role: 1 as const },
    { address: reviewed.lending.mintAddress, role: 0 as const },
    { address: fTokenMint, role: 1 as const },
    {
      address: reviewed.lending.tokenReservesLiquidityAddress,
      role: 1 as const,
    },
    {
      address: reviewed.lending.supplyPositionOnLiquidityAddress,
      role: 1 as const,
    },
    { address: rateModel, role: 0 as const },
    { address: reviewed.tokenReserve.vaultAddress, role: 1 as const },
    { address: claimAccount, role: 1 as const },
    { address: liquidity, role: 1 as const },
    { address: LIQUIDITY_PROGRAM, role: 1 as const },
    { address: reviewed.lending.rewardsRateModelAddress, role: 0 as const },
    { address: TOKEN_PROGRAM, role: 0 as const },
    { address: ASSOCIATED_TOKEN_PROGRAM, role: 0 as const },
    { address: SYSTEM_PROGRAM, role: 0 as const },
  ];
  const failure =
    profile.operation === "depositWithMinAmountOut"
      ? exactInstructionFailure(
          instruction,
          [116, 144, 16, 97, 118, 109, 40, 119],
          depositAccounts,
        )
      : exactInstructionFailure(
          instruction,
          [235, 189, 237, 56, 166, 180, 184, 149],
          redeemAccounts,
        );
  if (failure) return unsupported("operation-binding", failure, 0);

  const mapped = mapInstructionWithConfigs(
    instruction,
    snapshot,
    configs,
    classifications,
    environment,
  );
  if (mapped.kind !== "mapped") {
    return mapped.kind === "unsupported"
      ? unsupported(mapped.reason, mapped.message, 0)
      : unsupported(
          "destination-invariant",
          "Jupiter Earn profile cannot contain native passthrough",
          0,
        );
  }
  return Object.freeze({
    kind: "mappedOperation",
    operation: profile.operation,
    instructions: Object.freeze([mapped]),
  });
}

export {
  mapJupiterEarnOperationWithConfigs,
  validateJupiterOperationProfileConfig,
};
export type { JupiterOperationProfileConfig };
