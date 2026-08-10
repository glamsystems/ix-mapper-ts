import type {
  InstructionClassificationConfig,
  KaminoLendingRepayContext,
  KaminoLendingReserveRefreshBinding,
  KaminoLendingSdkVersion,
  MapKaminoLendingRepayOperationInput,
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

interface KlendSdkTuple {
  readonly package: "@kamino-finance/klend-sdk";
  readonly version: KaminoLendingSdkVersion;
  readonly npm_integrity: string;
  readonly tarball_sha256: string;
  readonly solana_kit_version: "2.3.0";
  readonly source_hashes: Readonly<Record<string, string>>;
}

interface KlendOperationProfile {
  readonly id: "klend.existing-obligation-classic-spl-repay-v2";
  readonly operation: "repayObligationLiquidityV2";
  readonly builder_authority: "@kamino-finance/klend-sdk generated builders";
  readonly ordering_evidence: "pinned KaminoAction.buildRepayTxns source";
  readonly bounded_binding: string;
  readonly maximum_active_reserves: number;
  readonly maximum_snapshot_age_slots: number;
  readonly amount: "positive-finite-u64";
  readonly token_program: string;
  readonly associated_token_program: string;
  readonly farms_program: string;
  readonly forbidden_liquidity_mints: readonly string[];
  readonly forbidden_helpers: readonly string[];
  readonly sequence: {
    readonly refresh_reserves: {
      readonly outcome: "operationBoundPassthrough";
      readonly position_start: 0;
      readonly program_id: string;
      readonly instruction: "refreshReserve";
      readonly exact_data: readonly number[];
      readonly accounts: readonly {
        readonly index: number;
        readonly role: 0 | 1 | 2 | 3;
        readonly binding: string;
      }[];
      readonly ordering: "deposits-then-borrows-deduplicated-target-last";
    };
    readonly refresh_obligation: {
      readonly outcome: "operationBoundPassthrough";
      readonly position: "after-refresh-reserves";
      readonly program_id: string;
      readonly instruction: "refreshObligation";
      readonly exact_data: readonly number[];
      readonly fixed_accounts: readonly {
        readonly index: number;
        readonly role: 0 | 1 | 2 | 3;
        readonly binding: string;
      }[];
      readonly remaining_accounts: {
        readonly role: 1;
        readonly binding: "deposit_reserves_then_borrow_reserves";
        readonly referrer_tail: "forbidden";
      };
    };
    readonly protocol: {
      readonly outcome: "mapped";
      readonly position: "final";
      readonly source_instruction: "repay_obligation_liquidity_v2";
      readonly mapping_ref: {
        readonly config_schema_version: 2;
        readonly config_revision: 1;
      };
      readonly account_bindings: readonly {
        readonly index: number;
        readonly role: 0 | 1 | 2 | 3;
        readonly binding: string;
      }[];
    };
  };
}

interface KlendOperationProfileConfig {
  readonly $schema?: string;
  readonly schema_version: 2;
  readonly config_revision: 1;
  readonly integration: "kamino-lending-repay";
  readonly official_sdk_tuple: KlendSdkTuple;
  readonly operations: readonly KlendOperationProfile[];
}

interface NormalizedRepayContext extends KaminoLendingRepayContext {
  readonly refreshOrder: readonly string[];
}

const KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
const FARMS_PROGRAM = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const BOUNDED_BINDING =
  "official decoded Kamino market/obligation/reserve snapshot plus immutable helper output";
const FORBIDDEN_HELPERS = [
  "associated-token-account",
  "compute-budget",
  "elevation-group",
  "farms",
  "fixed-term",
  "initialization",
  "lookup-table",
  "referrer",
  "repay-all",
  "scope-refresh",
  "token-2022",
  "wrapped-sol",
] as const;
const U64_MAX = (1n << 64n) - 1n;

function unsupported(
  reason: UnsupportedInstructionReason,
  message: string,
  instructionIndex: number | null,
): UnsupportedOperationResult {
  return { kind: "unsupported", reason, message, instructionIndex };
}

function assertKnownKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} has unknown field "${unknown.sort()[0]}"`);
  }
}

function requireObject<T>(
  value: T,
  label: string,
): asserts value is T & object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactBytes(
  value: unknown,
  expected: readonly number[],
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    !bytesEqual(new Uint8Array(value as number[]), new Uint8Array(expected))
  ) {
    throw new TypeError(`${label} bytes changed`);
  }
}

function assertDenseBindings(
  bindings: readonly { index: number; role: number; binding: string }[],
  expected: readonly { role: number; binding: string }[],
  label: string,
): void {
  if (
    !Array.isArray(bindings) ||
    bindings.length !== expected.length ||
    !bindings.every(
      (binding, index) =>
        binding.index === index &&
        binding.role === expected[index].role &&
        binding.binding === expected[index].binding &&
        Object.keys(binding).length === 3,
    )
  ) {
    throw new TypeError(`${label} account bindings changed`);
  }
}

function validateKlendOperationProfileConfig(
  input: KlendOperationProfileConfig,
  configs: StrictRemappingConfigs,
  environment: NeutralMapperEnvironment,
): KlendOperationProfileConfig {
  requireObject(input, "Klend operation profile");
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
    "Klend operation profile",
  );
  if (
    input.$schema !== "./schema-v2.json" ||
    input.schema_version !== 2 ||
    input.config_revision !== 1 ||
    input.integration !== "kamino-lending-repay"
  ) {
    throw new TypeError("Unsupported Klend operation profile identity");
  }
  const selectedProgram = configs[KLEND_PROGRAM];
  if (
    selectedProgram === undefined ||
    Object.keys(configs).length !== 1 ||
    selectedProgram.instructions.length !== 1 ||
    selectedProgram.instructions[0].src_ix_name !==
      "repay_obligation_liquidity_v2"
  ) {
    throw new TypeError("Klend operation profile requires one repay-v2 config");
  }

  const tuple = input.official_sdk_tuple;
  requireObject(tuple, "Klend official SDK tuple");
  assertKnownKeys(
    tuple,
    [
      "package",
      "version",
      "npm_integrity",
      "tarball_sha256",
      "solana_kit_version",
      "source_hashes",
    ],
    "Klend official SDK tuple",
  );
  if (
    tuple.package !== "@kamino-finance/klend-sdk" ||
    tuple.version !== "9.1.5" ||
    typeof tuple.npm_integrity !== "string" ||
    !tuple.npm_integrity.startsWith("sha512-") ||
    !/^[0-9a-f]{64}$/.test(tuple.tarball_sha256) ||
    tuple.solana_kit_version !== "2.3.0"
  ) {
    throw new TypeError("Klend active SDK tuple must be exactly 9.1.5");
  }
  requireObject(tuple.source_hashes, "Klend SDK source hashes");
  assertKnownKeys(
    tuple.source_hashes,
    [
      "refresh_reserve_builder",
      "refresh_obligation_builder",
      "repay_v2_builder",
      "high_level_action_helper",
    ],
    "Klend SDK source hashes",
  );
  if (
    !Object.values(tuple.source_hashes).every(
      (hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
    )
  ) {
    throw new TypeError("Klend SDK source hash is malformed");
  }

  if (!Array.isArray(input.operations) || input.operations.length !== 1) {
    throw new TypeError("Klend operation profile must contain one operation");
  }
  const profile = input.operations[0];
  requireObject(profile, "Klend repay profile");
  assertKnownKeys(
    profile,
    [
      "id",
      "operation",
      "builder_authority",
      "ordering_evidence",
      "bounded_binding",
      "maximum_active_reserves",
      "maximum_snapshot_age_slots",
      "amount",
      "token_program",
      "associated_token_program",
      "farms_program",
      "forbidden_liquidity_mints",
      "forbidden_helpers",
      "sequence",
    ],
    "Klend repay profile",
  );
  if (
    profile.id !== "klend.existing-obligation-classic-spl-repay-v2" ||
    profile.operation !== "repayObligationLiquidityV2" ||
    profile.builder_authority !==
      "@kamino-finance/klend-sdk generated builders" ||
    profile.ordering_evidence !== "pinned KaminoAction.buildRepayTxns source" ||
    profile.bounded_binding !== BOUNDED_BINDING ||
    profile.maximum_active_reserves !== 20 ||
    profile.maximum_snapshot_age_slots !== 20 ||
    profile.amount !== "positive-finite-u64" ||
    normalizeAddress(
      profile.token_program,
      "Klend token program",
      environment,
    ) !== TOKEN_PROGRAM ||
    normalizeAddress(
      profile.associated_token_program,
      "Klend associated token program",
      environment,
    ) !== ASSOCIATED_TOKEN_PROGRAM ||
    normalizeAddress(
      profile.farms_program,
      "Klend farms program",
      environment,
    ) !== FARMS_PROGRAM ||
    JSON.stringify(profile.forbidden_liquidity_mints) !==
      JSON.stringify([WRAPPED_SOL_MINT]) ||
    JSON.stringify(profile.forbidden_helpers) !==
      JSON.stringify(FORBIDDEN_HELPERS)
  ) {
    throw new TypeError("Klend repay profile contract is malformed");
  }

  const {
    refresh_reserves: reserves,
    refresh_obligation: obligation,
    protocol,
  } = profile.sequence;
  assertKnownKeys(
    reserves,
    [
      "outcome",
      "position_start",
      "program_id",
      "instruction",
      "exact_data",
      "accounts",
      "ordering",
    ],
    "Klend refresh-reserve profile",
  );
  if (
    reserves.outcome !== "operationBoundPassthrough" ||
    reserves.position_start !== 0 ||
    normalizeAddress(
      reserves.program_id,
      "Klend refresh program",
      environment,
    ) !== KLEND_PROGRAM ||
    reserves.instruction !== "refreshReserve" ||
    reserves.ordering !== "deposits-then-borrows-deduplicated-target-last"
  ) {
    throw new TypeError("Klend refresh-reserve sequence changed");
  }
  assertExactBytes(
    reserves.exact_data,
    [2, 218, 138, 235, 79, 201, 25, 102],
    "Klend refreshReserve",
  );
  assertDenseBindings(
    reserves.accounts,
    [
      { role: 1, binding: "reserve" },
      { role: 0, binding: "lending_market" },
      { role: 0, binding: "pyth_or_program_placeholder" },
      { role: 0, binding: "switchboard_price_or_program_placeholder" },
      { role: 0, binding: "switchboard_twap_or_program_placeholder" },
      { role: 0, binding: "program_placeholder_no_scope" },
    ],
    "Klend refreshReserve",
  );

  assertKnownKeys(
    obligation,
    [
      "outcome",
      "position",
      "program_id",
      "instruction",
      "exact_data",
      "fixed_accounts",
      "remaining_accounts",
    ],
    "Klend refresh-obligation profile",
  );
  if (
    obligation.outcome !== "operationBoundPassthrough" ||
    obligation.position !== "after-refresh-reserves" ||
    normalizeAddress(
      obligation.program_id,
      "Klend obligation program",
      environment,
    ) !== KLEND_PROGRAM ||
    obligation.instruction !== "refreshObligation" ||
    obligation.remaining_accounts.role !== 1 ||
    obligation.remaining_accounts.binding !==
      "deposit_reserves_then_borrow_reserves" ||
    obligation.remaining_accounts.referrer_tail !== "forbidden" ||
    Object.keys(obligation.remaining_accounts).length !== 3
  ) {
    throw new TypeError("Klend refresh-obligation sequence changed");
  }
  assertExactBytes(
    obligation.exact_data,
    [33, 132, 147, 228, 151, 192, 72, 89],
    "Klend refreshObligation",
  );
  assertDenseBindings(
    obligation.fixed_accounts,
    [
      { role: 0, binding: "lending_market" },
      { role: 1, binding: "obligation" },
    ],
    "Klend refreshObligation",
  );

  assertKnownKeys(
    protocol,
    [
      "outcome",
      "position",
      "source_instruction",
      "mapping_ref",
      "account_bindings",
    ],
    "Klend mapped protocol profile",
  );
  if (
    protocol.outcome !== "mapped" ||
    protocol.position !== "final" ||
    protocol.source_instruction !== "repay_obligation_liquidity_v2" ||
    protocol.mapping_ref.config_schema_version !== 2 ||
    protocol.mapping_ref.config_revision !== 1 ||
    Object.keys(protocol.mapping_ref).length !== 2
  ) {
    throw new TypeError("Klend mapped protocol sequence changed");
  }
  assertDenseBindings(
    protocol.account_bindings,
    [
      { role: 2, binding: "glam_vault" },
      { role: 1, binding: "obligation" },
      { role: 0, binding: "lending_market" },
      { role: 1, binding: "repay_reserve" },
      { role: 0, binding: "reserve_liquidity_mint" },
      { role: 1, binding: "reserve_destination_liquidity" },
      { role: 1, binding: "user_source_liquidity" },
      { role: 0, binding: "classic_spl_token_program" },
      { role: 0, binding: "instructions_sysvar" },
      { role: 0, binding: "program_placeholder_no_obligation_farm" },
      { role: 0, binding: "program_placeholder_no_reserve_farm" },
      { role: 0, binding: "lending_market_authority" },
      { role: 0, binding: "farms_program" },
    ],
    "Klend repay-v2",
  );

  return input;
}

function normalizeAddressArray(
  input: readonly string[],
  label: string,
  maximum: number,
  environment: NeutralMapperEnvironment,
): readonly string[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new TypeError(
      `${label} must contain at most ${String(maximum)} addresses`,
    );
  }
  const addresses = input.map((address, index) =>
    normalizeAddress(address, `${label} ${String(index)}`, environment),
  );
  if (new Set(addresses).size !== addresses.length) {
    throw new TypeError(`${label} contains duplicates`);
  }
  return Object.freeze(addresses);
}

function optionalOracle(
  input: unknown,
  label: string,
  environment: NeutralMapperEnvironment,
): string | null {
  if (input === null) return null;
  const address = normalizeAddress(input, label, environment);
  if (address === KLEND_PROGRAM) {
    throw new TypeError(`${label} cannot impersonate an absent oracle`);
  }
  return address;
}

function normalizeSlot(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${label} must be a non-negative bigint`);
  }
  return value;
}

function snapshotContext(
  context: NeutralMappingContext,
  environment: NeutralMapperEnvironment,
): NeutralMappingContext {
  requireObject(context, "Klend mapping context");
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

function normalizeRepayContext(
  input: KaminoLendingRepayContext,
  profile: KlendOperationProfile,
  environment: NeutralMapperEnvironment,
): NormalizedRepayContext {
  requireObject(input, "Klend reviewed context");
  assertKnownKeys(
    input,
    [
      "stateObservationSlot",
      "currentSlot",
      "elevationGroup",
      "hasActiveFarms",
      "hasFixedTermDebt",
      "referrerAddress",
      "sourceAtaExists",
      "lendingMarketAddress",
      "obligationAddress",
      "repayReserveAddress",
      "reserveLiquidityMintAddress",
      "reserveDestinationLiquidityAddress",
      "userSourceLiquidityAddress",
      "lendingMarketAuthorityAddress",
      "depositReserveAddresses",
      "borrowReserveAddresses",
      "reserveRefreshBindings",
    ],
    "Klend reviewed context",
  );
  const stateObservationSlot = normalizeSlot(
    input.stateObservationSlot,
    "Klend state observation slot",
  );
  const currentSlot = normalizeSlot(input.currentSlot, "Klend current slot");
  if (
    currentSlot < stateObservationSlot ||
    currentSlot - stateObservationSlot >
      BigInt(profile.maximum_snapshot_age_slots)
  ) {
    throw new TypeError(
      "Klend decoded state snapshot is stale or from the future",
    );
  }
  if (
    input.elevationGroup !== 0 ||
    input.hasActiveFarms !== false ||
    input.hasFixedTermDebt !== false ||
    input.referrerAddress !== null ||
    input.sourceAtaExists !== true
  ) {
    throw new TypeError(
      "Klend repay requires elevation zero, no farms, no fixed-term debt, no referrer, and an existing source ATA",
    );
  }
  const normalize = (value: unknown, label: string) =>
    normalizeAddress(value, label, environment);
  const lendingMarketAddress = normalize(
    input.lendingMarketAddress,
    "Klend lending market",
  );
  const obligationAddress = normalize(
    input.obligationAddress,
    "Klend obligation",
  );
  const repayReserveAddress = normalize(
    input.repayReserveAddress,
    "Klend repay reserve",
  );
  const depositReserveAddresses = normalizeAddressArray(
    input.depositReserveAddresses,
    "Klend deposit reserves",
    profile.maximum_active_reserves,
    environment,
  );
  const borrowReserveAddresses = normalizeAddressArray(
    input.borrowReserveAddresses,
    "Klend borrow reserves",
    profile.maximum_active_reserves,
    environment,
  );
  if (!borrowReserveAddresses.includes(repayReserveAddress)) {
    throw new TypeError("Klend repay reserve is not an active borrow reserve");
  }
  const active = [
    ...new Set([...depositReserveAddresses, ...borrowReserveAddresses]),
  ];
  if (active.length === 0 || active.length > profile.maximum_active_reserves) {
    throw new TypeError("Klend active reserve union is outside profile bounds");
  }
  const refreshOrder = Object.freeze([
    ...active.filter((address) => address !== repayReserveAddress),
    repayReserveAddress,
  ]);

  if (
    !Array.isArray(input.reserveRefreshBindings) ||
    input.reserveRefreshBindings.length !== refreshOrder.length
  ) {
    throw new TypeError(
      "Klend reserve refresh bindings do not exhaust refresh order",
    );
  }
  const reserveRefreshBindings = Object.freeze(
    input.reserveRefreshBindings.map((binding, index) => {
      requireObject(binding, `Klend reserve binding ${String(index)}`);
      assertKnownKeys(
        binding,
        [
          "reserveAddress",
          "pythOracleAddress",
          "switchboardPriceOracleAddress",
          "switchboardTwapOracleAddress",
          "scopePricesAddress",
        ],
        `Klend reserve binding ${String(index)}`,
      );
      const reserveAddress = normalize(
        binding.reserveAddress,
        `Klend reserve binding ${String(index)}`,
      );
      if (reserveAddress !== refreshOrder[index]) {
        throw new TypeError(
          "Klend reserve refresh order does not match official helper order",
        );
      }
      if (binding.scopePricesAddress !== null) {
        throw new TypeError(
          "Klend Scope-priced reserves are outside this profile",
        );
      }
      return Object.freeze({
        reserveAddress,
        pythOracleAddress: optionalOracle(
          binding.pythOracleAddress,
          `Klend reserve ${String(index)} Pyth oracle`,
          environment,
        ),
        switchboardPriceOracleAddress: optionalOracle(
          binding.switchboardPriceOracleAddress,
          `Klend reserve ${String(index)} Switchboard price oracle`,
          environment,
        ),
        switchboardTwapOracleAddress: optionalOracle(
          binding.switchboardTwapOracleAddress,
          `Klend reserve ${String(index)} Switchboard TWAP oracle`,
          environment,
        ),
        scopePricesAddress: null,
      }) as KaminoLendingReserveRefreshBinding;
    }),
  );

  const reserveLiquidityMintAddress = normalize(
    input.reserveLiquidityMintAddress,
    "Klend reserve liquidity mint",
  );
  if (profile.forbidden_liquidity_mints.includes(reserveLiquidityMintAddress)) {
    throw new TypeError("Klend wrapped-SOL reserves are outside this profile");
  }

  return Object.freeze({
    stateObservationSlot,
    currentSlot,
    elevationGroup: 0,
    hasActiveFarms: false,
    hasFixedTermDebt: false,
    referrerAddress: null,
    sourceAtaExists: true,
    lendingMarketAddress,
    obligationAddress,
    repayReserveAddress,
    reserveLiquidityMintAddress,
    reserveDestinationLiquidityAddress: normalize(
      input.reserveDestinationLiquidityAddress,
      "Klend reserve destination liquidity",
    ),
    userSourceLiquidityAddress: normalize(
      input.userSourceLiquidityAddress,
      "Klend user source liquidity",
    ),
    lendingMarketAuthorityAddress: normalize(
      input.lendingMarketAuthorityAddress,
      "Klend lending market authority",
    ),
    depositReserveAddresses,
    borrowReserveAddresses,
    reserveRefreshBindings,
    refreshOrder,
  });
}

function exactInstructionFailure(
  instruction: NeutralInstruction,
  expected: {
    readonly program: string;
    readonly data?: readonly number[];
    readonly accounts: readonly { address: string; role: 0 | 1 | 2 | 3 }[];
  },
  name: string,
): string | undefined {
  if (instruction.programAddress !== expected.program) {
    return `${name} has an unexpected program`;
  }
  if (
    expected.data !== undefined &&
    !bytesEqual(instruction.data, new Uint8Array(expected.data))
  ) {
    return `${name} data changed`;
  }
  if (instruction.accounts.length !== expected.accounts.length) {
    return `${name} has an unexpected account count`;
  }
  for (let index = 0; index < expected.accounts.length; index += 1) {
    const actual = instruction.accounts[index];
    const account = expected.accounts[index];
    if (actual.role !== account.role) {
      return `${name} account ${String(index)} has unexpected privileges`;
    }
    if (actual.address !== account.address) {
      return `${name} account ${String(index)} has an unexpected identity`;
    }
  }
  return undefined;
}

function decodeFiniteU64(data: Uint8Array): bigint | undefined {
  if (data.length !== 16) return undefined;
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(data[8 + index]) << BigInt(index * 8);
  }
  return value > 0n && value < U64_MAX ? value : undefined;
}

function expectedOptionalOracle(address: string | null): string {
  return address ?? KLEND_PROGRAM;
}

async function mapKaminoLendingRepayOperationWithConfigs(
  input: MapKaminoLendingRepayOperationInput,
  context: NeutralMappingContext,
  configs: StrictRemappingConfigs,
  classifications: InstructionClassificationConfig,
  operationProfiles: KlendOperationProfileConfig,
  environment: NeutralMapperEnvironment,
): Promise<NeutralMapOperationResult> {
  let sdkVersion: KaminoLendingSdkVersion;
  let instructions: readonly NeutralInstruction[];
  let reviewed: NormalizedRepayContext;
  let snapshot: NeutralMappingContext;
  const profile = operationProfiles.operations[0];
  try {
    requireObject(input, "Klend repay operation input");
    assertKnownKeys(
      input,
      ["operation", "officialSdkVersion", "instructions", "reviewedContext"],
      "Klend repay operation input",
    );
    if (input.operation !== profile.operation) {
      throw new TypeError("Klend operation must be repayObligationLiquidityV2");
    }
    if (
      operationProfiles.official_sdk_tuple.version !== input.officialSdkVersion
    ) {
      throw new TypeError("Klend official SDK tuple is not reviewed");
    }
    sdkVersion = input.officialSdkVersion;
    if (!Array.isArray(input.instructions)) {
      throw new TypeError("Klend operation instructions must be an array");
    }
    reviewed = normalizeRepayContext(
      input.reviewedContext,
      profile,
      environment,
    );
    snapshot = snapshotContext(context, environment);
    if (input.instructions.length !== reviewed.refreshOrder.length + 2) {
      throw new TypeError(
        `Klend repay requires ${String(reviewed.refreshOrder.length)} reserve refreshes, one obligation refresh, and one repay-v2 instruction`,
      );
    }
    instructions = Object.freeze(
      input.instructions.map((instruction) =>
        normalizeInstructionNeutral(instruction, environment),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "operation-shape",
      `Klend repay operation could not be normalized safely: ${message}`,
      null,
    );
  }

  const deriveAssociatedTokenAddress = environment.deriveAssociatedTokenAddress;
  if (typeof deriveAssociatedTokenAddress !== "function") {
    return unsupported(
      "operation-binding",
      "Klend repay requires an associated-token derivation binding",
      null,
    );
  }
  let derivedSourceLiquidity: string;
  try {
    derivedSourceLiquidity = normalizeAddress(
      await deriveAssociatedTokenAddress({
        ownerAddress: snapshot.glamVaultAddress,
        mintAddress: reviewed.reserveLiquidityMintAddress,
        tokenProgramAddress: profile.token_program,
        associatedTokenProgramAddress: profile.associated_token_program,
      }),
      "Klend derived source liquidity account",
      environment,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "operation-binding",
      `Klend source ATA derivation failed: ${message}`,
      null,
    );
  }
  if (derivedSourceLiquidity !== reviewed.userSourceLiquidityAddress) {
    return unsupported(
      "operation-binding",
      "Klend user source liquidity is not the canonical GLAM-vault ATA",
      null,
    );
  }

  const results: Array<
    Exclude<
      NeutralMapOperationResult,
      UnsupportedOperationResult
    >["instructions"][number]
  > = [];
  for (
    let index = 0;
    index < reviewed.reserveRefreshBindings.length;
    index += 1
  ) {
    const binding = reviewed.reserveRefreshBindings[index];
    const instruction = instructions[index];
    const failure = exactInstructionFailure(
      instruction,
      {
        program: profile.sequence.refresh_reserves.program_id,
        data: profile.sequence.refresh_reserves.exact_data,
        accounts: [
          { address: binding.reserveAddress, role: 1 },
          { address: reviewed.lendingMarketAddress, role: 0 },
          {
            address: expectedOptionalOracle(binding.pythOracleAddress),
            role: 0,
          },
          {
            address: expectedOptionalOracle(
              binding.switchboardPriceOracleAddress,
            ),
            role: 0,
          },
          {
            address: expectedOptionalOracle(
              binding.switchboardTwapOracleAddress,
            ),
            role: 0,
          },
          { address: KLEND_PROGRAM, role: 0 },
        ],
      },
      "refreshReserve",
    );
    if (failure !== undefined) {
      return unsupported("operation-binding", failure, index);
    }
    results.push({
      kind: "safePassthrough",
      instruction,
      sourceInstructionName: "refreshReserve",
    });
  }

  const obligationIndex = reviewed.refreshOrder.length;
  const obligationInstruction = instructions[obligationIndex];
  const obligationFailure = exactInstructionFailure(
    obligationInstruction,
    {
      program: profile.sequence.refresh_obligation.program_id,
      data: profile.sequence.refresh_obligation.exact_data,
      accounts: [
        { address: reviewed.lendingMarketAddress, role: 0 },
        { address: reviewed.obligationAddress, role: 1 },
        ...reviewed.depositReserveAddresses.map((address) => ({
          address,
          role: 1 as const,
        })),
        ...reviewed.borrowReserveAddresses.map((address) => ({
          address,
          role: 1 as const,
        })),
      ],
    },
    "refreshObligation",
  );
  if (obligationFailure !== undefined) {
    return unsupported("operation-binding", obligationFailure, obligationIndex);
  }
  results.push({
    kind: "safePassthrough",
    instruction: obligationInstruction,
    sourceInstructionName: "refreshObligation",
  });

  const repayIndex = obligationIndex + 1;
  const repayInstruction = instructions[repayIndex];
  if (decodeFiniteU64(repayInstruction.data) === undefined) {
    return unsupported(
      "invalid-data",
      "Klend repay-v2 amount must be a positive finite u64 and cannot use the repay-all sentinel",
      repayIndex,
    );
  }
  const protocolAccounts = [
    { address: snapshot.glamVaultAddress, role: 2 as const },
    { address: reviewed.obligationAddress, role: 1 as const },
    { address: reviewed.lendingMarketAddress, role: 0 as const },
    { address: reviewed.repayReserveAddress, role: 1 as const },
    { address: reviewed.reserveLiquidityMintAddress, role: 0 as const },
    { address: reviewed.reserveDestinationLiquidityAddress, role: 1 as const },
    { address: reviewed.userSourceLiquidityAddress, role: 1 as const },
    { address: TOKEN_PROGRAM, role: 0 as const },
    { address: INSTRUCTIONS_SYSVAR, role: 0 as const },
    { address: KLEND_PROGRAM, role: 0 as const },
    { address: KLEND_PROGRAM, role: 0 as const },
    { address: reviewed.lendingMarketAuthorityAddress, role: 0 as const },
    { address: FARMS_PROGRAM, role: 0 as const },
  ];
  const relationFailure = exactInstructionFailure(
    repayInstruction,
    {
      program: KLEND_PROGRAM,
      accounts: protocolAccounts,
    },
    "repayObligationLiquidityV2",
  );
  // The amount is dynamic. decodeFiniteU64 above and strict mapping below
  // validate the exact 16-byte discriminator/amount layout.
  if (relationFailure !== undefined) {
    return unsupported("operation-binding", relationFailure, repayIndex);
  }
  const mapped = mapInstructionWithConfigs(
    repayInstruction,
    snapshot,
    configs,
    classifications,
    environment,
  );
  if (mapped.kind !== "mapped") {
    const reason =
      mapped.kind === "unsupported" ? mapped.reason : "operation-shape";
    const message =
      mapped.kind === "unsupported"
        ? mapped.message
        : "repay-v2 unexpectedly matched a native passthrough rule";
    return unsupported(
      reason,
      `Klend ${sdkVersion} repay-v2 instruction is unsupported: ${message}`,
      repayIndex,
    );
  }
  if (
    mapped.sourceInstructionName !==
    profile.sequence.protocol.source_instruction
  ) {
    return unsupported(
      "operation-shape",
      "Klend final instruction did not resolve to the reviewed repay-v2 mapping",
      repayIndex,
    );
  }
  results.push(mapped);

  return {
    kind: "mappedOperation",
    operation: "repayObligationLiquidityV2",
    instructions: Object.freeze(results),
  };
}

export {
  mapKaminoLendingRepayOperationWithConfigs,
  validateKlendOperationProfileConfig,
};
export type { KlendOperationProfileConfig };
