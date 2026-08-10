import type {
  InstructionClassificationConfig,
  KaminoKvaultOperationName,
  MapKaminoKvaultOperationInput,
  NeutralInstruction,
  NeutralMapOperationResult,
  NeutralMapperEnvironment,
  NeutralMappingContext,
  OperationProfileConfig,
  OperationProfileSetupAccount,
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

type ValidatedOperationProfileConfig = OperationProfileConfig;
type OperationProfile = OperationProfileConfig["operations"][number];

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

function requireInteger(
  value: unknown,
  label: string,
  minimum = 0,
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${label} must be an integer >= ${String(minimum)}`);
  }
}

function requireProfileAccount(
  account: OperationProfileSetupAccount,
  expectedIndex: number,
  profileId: string,
  environment: NeutralMapperEnvironment,
): OperationProfileSetupAccount {
  if (
    typeof account !== "object" ||
    account === null ||
    Array.isArray(account)
  ) {
    throw new TypeError(
      `${profileId} setup account ${expectedIndex} must be an object`,
    );
  }
  assertKnownKeys(
    account,
    ["index", "role", "account", "binding"],
    `${profileId} setup account ${expectedIndex}`,
  );
  requireInteger(account.index, `${profileId} setup account index`);
  if (account.index !== expectedIndex) {
    throw new TypeError(
      `${profileId} setup account indices must be dense from zero`,
    );
  }
  requireInteger(account.role, `${profileId} setup account role`);
  if (account.role > 3) {
    throw new TypeError(`${profileId} setup account role must be 0..3`);
  }
  if ((account.account === undefined) === (account.binding === undefined)) {
    throw new TypeError(
      `${profileId} setup account ${expectedIndex} must declare exactly one identity`,
    );
  }
  const staticAddress =
    account.account === undefined
      ? undefined
      : normalizeAddress(
          account.account,
          `${profileId} setup account ${expectedIndex}`,
          environment,
        );
  const bindings = new Set([
    "ata_payer",
    "derived_associated_token_account",
    "glam_vault",
    "protocol_token_mint",
    "protocol_token_program",
  ]);
  if (account.binding !== undefined && !bindings.has(account.binding)) {
    throw new TypeError(
      `${profileId} setup account ${expectedIndex} has an unknown binding`,
    );
  }
  return Object.freeze({ ...account, account: staticAddress });
}

function validateOperationProfileConfig(
  input: OperationProfileConfig,
  configs: StrictRemappingConfigs,
  environment: NeutralMapperEnvironment,
): ValidatedOperationProfileConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Operation profile config must be an object");
  }
  assertKnownKeys(
    input,
    [
      "$schema",
      "schema_version",
      "config_revision",
      "integration",
      "operations",
    ],
    "Operation profile config",
  );
  if (input.schema_version !== 1 || input.integration !== "kamino-kvaults") {
    throw new TypeError("Unsupported KVault operation profile identity");
  }
  requireInteger(input.config_revision, "Operation profile revision", 1);
  if (!Array.isArray(input.operations) || input.operations.length !== 2) {
    throw new TypeError(
      "KVault operation profile must contain deposit and withdraw exactly once",
    );
  }

  const selectedProgram = Object.values(configs)[0];
  if (selectedProgram === undefined || Object.keys(configs).length !== 1) {
    throw new TypeError(
      "KVault operation profile requires one strict program config",
    );
  }
  const seenOperations = new Set<KaminoKvaultOperationName>();
  const seenIds = new Set<string>();
  const operations = input.operations.map((profile) => {
    if (
      typeof profile !== "object" ||
      profile === null ||
      Array.isArray(profile)
    ) {
      throw new TypeError("KVault operation profile entry must be an object");
    }
    assertKnownKeys(
      profile,
      [
        "id",
        "operation",
        "official_emitter",
        "bounded_binding",
        "setup",
        "protocol",
      ],
      "KVault operation profile entry",
    );
    if (
      typeof profile.id !== "string" ||
      profile.id.length === 0 ||
      seenIds.has(profile.id)
    ) {
      throw new TypeError(
        "KVault operation profile IDs must be non-empty and unique",
      );
    }
    seenIds.add(profile.id);
    if (
      (profile.operation !== "deposit" && profile.operation !== "withdraw") ||
      seenOperations.has(profile.operation)
    ) {
      throw new TypeError(
        "KVault operation names must be deposit and withdraw exactly once",
      );
    }
    seenOperations.add(profile.operation);
    if (
      typeof profile.official_emitter !== "string" ||
      profile.official_emitter.length === 0 ||
      typeof profile.bounded_binding !== "string" ||
      profile.bounded_binding.length === 0
    ) {
      throw new TypeError(
        `${profile.id} must identify its official emitter and bounded binding`,
      );
    }

    const { setup, protocol } = profile;
    assertKnownKeys(
      setup,
      [
        "outcome",
        "position",
        "program_id",
        "instruction",
        "exact_data",
        "accounts",
      ],
      `${profile.id} setup`,
    );
    if (
      setup.outcome !== "operationBoundPassthrough" ||
      setup.position !== 0 ||
      typeof setup.instruction !== "string" ||
      setup.instruction.length === 0
    ) {
      throw new TypeError(`${profile.id} has an invalid setup contract`);
    }
    normalizeAddress(
      setup.program_id,
      `${profile.id} setup program`,
      environment,
    );
    if (
      !Array.isArray(setup.exact_data) ||
      setup.exact_data.length === 0 ||
      setup.exact_data.some(
        (byte: number) => !Number.isInteger(byte) || byte < 0 || byte > 255,
      )
    ) {
      throw new TypeError(`${profile.id} setup data must be exact bytes`);
    }
    if (!Array.isArray(setup.accounts) || setup.accounts.length === 0) {
      throw new TypeError(`${profile.id} setup accounts must not be empty`);
    }
    const accounts = setup.accounts.map(
      (account: OperationProfileSetupAccount, index: number) =>
        requireProfileAccount(account, index, profile.id, environment),
    );

    assertKnownKeys(
      protocol,
      [
        "start_position",
        "source_instruction",
        "minimum_count",
        "maximum_count",
        "owner_account_index",
        "token_account_index",
        "token_mint_index",
        "token_program_index",
        "forbidden_mint_account_indices",
        "forbidden_mints",
      ],
      `${profile.id} protocol`,
    );
    if (
      protocol.start_position !== 1 ||
      protocol.source_instruction !== profile.operation
    ) {
      throw new TypeError(
        `${profile.id} protocol source does not match its operation`,
      );
    }
    requireInteger(protocol.minimum_count, `${profile.id} minimum count`, 1);
    requireInteger(protocol.maximum_count, `${profile.id} maximum count`, 1);
    if (
      protocol.minimum_count > protocol.maximum_count ||
      protocol.maximum_count > 25
    ) {
      throw new TypeError(`${profile.id} protocol count bounds are invalid`);
    }
    const sourceMapping = selectedProgram.instructions.find(
      (instruction) => instruction.src_ix_name === protocol.source_instruction,
    );
    if (sourceMapping === undefined) {
      throw new TypeError(
        `${profile.id} references a missing strict source mapping`,
      );
    }
    const fixedAccountCount = sourceMapping.strict.fixed_accounts.length;
    for (const [label, index] of [
      ["owner", protocol.owner_account_index],
      ["token account", protocol.token_account_index],
      ["token mint", protocol.token_mint_index],
      ["token program", protocol.token_program_index],
    ] as const) {
      requireInteger(index, `${profile.id} ${label} index`);
      if (index >= fixedAccountCount) {
        throw new TypeError(
          `${profile.id} ${label} index exceeds the strict fixed accounts`,
        );
      }
    }
    if (
      !Array.isArray(protocol.forbidden_mint_account_indices) ||
      protocol.forbidden_mint_account_indices.length === 0 ||
      new Set(protocol.forbidden_mint_account_indices).size !==
        protocol.forbidden_mint_account_indices.length
    ) {
      throw new TypeError(
        `${profile.id} forbidden mint indices must be non-empty and unique`,
      );
    }
    protocol.forbidden_mint_account_indices.forEach((index: number) => {
      requireInteger(index, `${profile.id} forbidden mint index`);
      if (index >= fixedAccountCount) {
        throw new TypeError(
          `${profile.id} forbidden mint index exceeds the strict fixed accounts`,
        );
      }
    });
    if (
      !Array.isArray(protocol.forbidden_mints) ||
      protocol.forbidden_mints.length === 0
    ) {
      throw new TypeError(`${profile.id} forbidden mints must not be empty`);
    }
    const forbiddenMints = protocol.forbidden_mints.map((mint: string) =>
      normalizeAddress(mint, `${profile.id} forbidden mint`, environment),
    );
    if (new Set(forbiddenMints).size !== forbiddenMints.length) {
      throw new TypeError(`${profile.id} forbidden mints must be unique`);
    }

    return Object.freeze({
      ...profile,
      setup: Object.freeze({
        ...setup,
        exact_data: Object.freeze([...setup.exact_data]),
        accounts: Object.freeze(accounts),
      }),
      protocol: Object.freeze({
        ...protocol,
        forbidden_mint_account_indices: Object.freeze([
          ...protocol.forbidden_mint_account_indices,
        ]),
        forbidden_mints: Object.freeze(forbiddenMints),
      }),
    });
  });

  return Object.freeze({
    ...input,
    operations: Object.freeze(operations),
  }) as ValidatedOperationProfileConfig;
}

function requireInputShape(input: MapKaminoKvaultOperationInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("KVault operation input must be an object");
  }
  assertKnownKeys(
    input,
    ["operation", "instructions", "ataPayerAddress"],
    "KVault operation input",
  );
  if (input.operation !== "deposit" && input.operation !== "withdraw") {
    throw new TypeError("KVault operation must be deposit or withdraw");
  }
  if (!Array.isArray(input.instructions)) {
    throw new TypeError("KVault operation instructions must be an array");
  }
}

function snapshotContext(
  context: NeutralMappingContext,
  environment: NeutralMapperEnvironment,
): NeutralMappingContext {
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    throw new TypeError("KVault mapping context must be an object");
  }
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

function sharedProtocolAddress(
  instructions: readonly NeutralInstruction[],
  index: number,
  label: string,
): string | UnsupportedOperationResult {
  const expected = instructions[0]?.accounts[index]?.address;
  if (expected === undefined) {
    return unsupported(
      "operation-shape",
      `KVault ${label} account ${index} is missing`,
      1,
    );
  }
  for (
    let instructionIndex = 1;
    instructionIndex < instructions.length;
    instructionIndex += 1
  ) {
    if (instructions[instructionIndex].accounts[index]?.address !== expected) {
      return unsupported(
        "operation-binding",
        `KVault ${label} differs across protocol instructions`,
        instructionIndex + 1,
      );
    }
  }
  return expected;
}

function setupBindingAddress(
  account: OperationProfileSetupAccount,
  bindings: Readonly<Record<string, string>>,
): string {
  if (account.account !== undefined) return account.account;
  const address =
    account.binding === undefined ? undefined : bindings[account.binding];
  if (address === undefined)
    throw new TypeError("Operation setup binding is missing");
  return address;
}

/** Map one complete presented KVault sequence; the bounded adapter owns provenance. */
async function mapKaminoKvaultOperationWithConfigs(
  input: MapKaminoKvaultOperationInput,
  context: NeutralMappingContext,
  configs: StrictRemappingConfigs,
  classifications: InstructionClassificationConfig,
  operationProfiles: ValidatedOperationProfileConfig,
  environment: NeutralMapperEnvironment,
): Promise<NeutralMapOperationResult> {
  let profile: OperationProfile | undefined;
  let operation: KaminoKvaultOperationName;
  let instructions: readonly NeutralInstruction[];
  let snapshot: NeutralMappingContext;
  let ataPayerAddress: string;
  try {
    requireInputShape(input);
    operation = input.operation;
    profile = operationProfiles.operations.find(
      ({ operation: candidate }) => candidate === operation,
    );
    if (profile === undefined) {
      return unsupported(
        "operation-shape",
        `No reviewed KVault ${operation} profile is configured`,
        null,
      );
    }
    instructions = Object.freeze(
      input.instructions.map((instruction) =>
        normalizeInstructionNeutral(instruction, environment),
      ),
    );
    snapshot = snapshotContext(context, environment);
    ataPayerAddress = normalizeAddress(
      input.ataPayerAddress,
      "KVault ATA payer",
      environment,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "invalid-instruction",
      `KVault operation could not be normalized safely: ${message}`,
      null,
    );
  }

  const protocolCount = instructions.length - profile.protocol.start_position;
  if (
    protocolCount < profile.protocol.minimum_count ||
    protocolCount > profile.protocol.maximum_count
  ) {
    return unsupported(
      "operation-shape",
      `KVault ${operation} requires one setup instruction followed by ${profile.protocol.minimum_count === profile.protocol.maximum_count ? String(profile.protocol.minimum_count) : `${String(profile.protocol.minimum_count)}..${String(profile.protocol.maximum_count)}`} ${profile.protocol.source_instruction} instruction(s); received ${String(instructions.length)} total`,
      null,
    );
  }

  const protocolSources = instructions.slice(profile.protocol.start_position);
  const mappedProtocol = [];
  for (let index = 0; index < protocolSources.length; index += 1) {
    const result = mapInstructionWithConfigs(
      protocolSources[index],
      snapshot,
      configs,
      classifications,
      environment,
    );
    const sourceIndex = index + profile.protocol.start_position;
    if (result.kind === "unsupported") {
      return unsupported(
        result.reason,
        `KVault ${operation} protocol instruction ${String(index)} is unsupported: ${result.message}`,
        sourceIndex,
      );
    }
    if (result.kind === "safePassthrough") {
      return unsupported(
        "operation-shape",
        `KVault ${operation} protocol instruction ${String(index)} must be mapped through GLAM`,
        sourceIndex,
      );
    }
    if (result.sourceInstructionName !== profile.protocol.source_instruction) {
      return unsupported(
        "operation-shape",
        `KVault ${operation} cannot contain ${result.sourceInstructionName}`,
        sourceIndex,
      );
    }
    for (const forbiddenIndex of profile.protocol
      .forbidden_mint_account_indices) {
      const address = protocolSources[index].accounts[forbiddenIndex]?.address;
      if (address === undefined) {
        return unsupported(
          "operation-shape",
          `KVault forbidden mint account ${forbiddenIndex} is missing`,
          sourceIndex,
        );
      }
      if (profile.protocol.forbidden_mints.includes(address)) {
        return unsupported(
          "operation-binding",
          `KVault ${operation} wrapped-SOL helpers are not supported`,
          sourceIndex,
        );
      }
    }
    mappedProtocol.push(result);
  }

  const ownerAddress = sharedProtocolAddress(
    protocolSources,
    profile.protocol.owner_account_index,
    "owner",
  );
  if (typeof ownerAddress !== "string") return ownerAddress;
  if (ownerAddress !== snapshot.glamVaultAddress) {
    return unsupported(
      "operation-binding",
      "KVault protocol owner must be the GLAM vault",
      1,
    );
  }
  const tokenAccount = sharedProtocolAddress(
    protocolSources,
    profile.protocol.token_account_index,
    "token account",
  );
  if (typeof tokenAccount !== "string") return tokenAccount;
  const tokenMint = sharedProtocolAddress(
    protocolSources,
    profile.protocol.token_mint_index,
    "token mint",
  );
  if (typeof tokenMint !== "string") return tokenMint;
  const tokenProgram = sharedProtocolAddress(
    protocolSources,
    profile.protocol.token_program_index,
    "token program",
  );
  if (typeof tokenProgram !== "string") return tokenProgram;

  const deriveAssociatedTokenAddress = environment.deriveAssociatedTokenAddress;
  if (typeof deriveAssociatedTokenAddress !== "function") {
    return unsupported(
      "operation-binding",
      "KVault ATA passthrough requires an associated-token derivation binding",
      0,
    );
  }
  let derivedTokenAccount: string;
  try {
    derivedTokenAccount = normalizeAddress(
      await deriveAssociatedTokenAddress({
        ownerAddress,
        mintAddress: tokenMint,
        tokenProgramAddress: tokenProgram,
        associatedTokenProgramAddress: profile.setup.program_id,
      }),
      "derived associated token account",
      environment,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "operation-binding",
      `KVault associated-token derivation failed: ${message}`,
      0,
    );
  }
  if (derivedTokenAccount !== tokenAccount) {
    return unsupported(
      "operation-binding",
      "KVault token account is not the canonical associated token account",
      0,
    );
  }

  const setup = instructions[profile.setup.position];
  if (
    setup === undefined ||
    setup.programAddress !== profile.setup.program_id ||
    !bytesEqual(setup.data, Uint8Array.from(profile.setup.exact_data)) ||
    setup.accounts.length !== profile.setup.accounts.length
  ) {
    return unsupported(
      "operation-shape",
      `KVault ${operation} setup is not the exact reviewed associated-token instruction`,
      0,
    );
  }
  const bindings = Object.freeze({
    ata_payer: ataPayerAddress,
    derived_associated_token_account: derivedTokenAccount,
    glam_vault: snapshot.glamVaultAddress,
    protocol_token_mint: tokenMint,
    protocol_token_program: tokenProgram,
  });
  for (const expected of profile.setup.accounts) {
    const actual = setup.accounts[expected.index];
    if (actual === undefined || actual.role !== expected.role) {
      return unsupported(
        "operation-binding",
        `KVault setup account ${expected.index} has the wrong role`,
        0,
      );
    }
    if (actual.address !== setupBindingAddress(expected, bindings)) {
      return unsupported(
        "operation-binding",
        `KVault setup account ${expected.index} has the wrong identity`,
        0,
      );
    }
  }

  return {
    kind: "mappedOperation",
    operation,
    instructions: [
      {
        kind: "safePassthrough",
        instruction: setup,
        sourceInstructionName: profile.setup.instruction,
      },
      ...mappedProtocol,
    ],
  };
}

export { mapKaminoKvaultOperationWithConfigs, validateOperationProfileConfig };
