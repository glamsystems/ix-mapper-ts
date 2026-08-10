import {
  type InstructionClassificationConfig,
  type NeutralAccountMeta,
  type NeutralInstruction,
  type NeutralMapInstructionResult,
  type NeutralMapperEnvironment,
  type NeutralMappingContext,
  type SafePassthroughInstructionClassification,
  type StrictAccountConstraint,
  type StrictDynamicAccountName,
  type StrictInstruction,
  type StrictRemappingConfig,
  type StrictRemappingConfigs,
  type UnsupportedInstructionReason,
  type UnsupportedInstructionResult,
} from "./core-types";
import {
  bytesEqual,
  bytesStartWith,
  concatBytes,
  isAccountRole,
  normalizeAddress,
  roleFromFlags,
} from "./neutral";

const STRICT_DYNAMIC_ACCOUNT_NAMES = new Set<StrictDynamicAccountName>([
  "glam_state",
  "glam_vault",
  "glam_signer",
  "integration_authority",
]);

function assertKnownKeys(
  config: StrictRemappingConfig,
  instructionName: string | undefined,
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw configError(
      config,
      instructionName,
      `${label} has unknown field "${unknown.sort()[0]}"`,
    );
  }
}

function configError(
  config: StrictRemappingConfig,
  instructionName: string | undefined,
  message: string,
): Error {
  const location = instructionName
    ? `${config.program_id}:${instructionName}`
    : config.program_id;
  return new Error(`Invalid schema-v2 mapping ${location}: ${message}`);
}

function assertByteArray(
  config: StrictRemappingConfig,
  instructionName: string,
  label: string,
  bytes: number[],
): void {
  if (!Array.isArray(bytes) || bytes.length === 0) {
    throw configError(config, instructionName, `${label} must not be empty`);
  }
  bytes.forEach((byte, index) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw configError(
        config,
        instructionName,
        `${label}[${index}] is not a byte`,
      );
    }
  });
}

function assertDenseUniqueDestinationIndices(
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
): void {
  const indices = [
    ...instruction.dynamic_accounts.map(({ index }) => index),
    ...instruction.static_accounts.map(({ index }) => index),
    ...instruction.index_map.filter((index) => index !== -1),
  ];
  const seen = new Set<number>();
  const sorted = [...indices].sort((a, b) => a - b);

  sorted.forEach((index) => {
    if (!Number.isInteger(index) || index < 0) {
      throw configError(
        config,
        instruction.src_ix_name,
        `destination account index ${index} is invalid`,
      );
    }
    if (seen.has(index)) {
      throw configError(
        config,
        instruction.src_ix_name,
        `destination account index ${index} is duplicated`,
      );
    }
    seen.add(index);
  });

  sorted.forEach((index, expected) => {
    if (index !== expected) {
      throw configError(
        config,
        instruction.src_ix_name,
        `destination accounts must be dense from index 0; found ${index} at position ${expected}`,
      );
    }
  });
}

function validateIdentityConstraint(
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
  constraint: StrictAccountConstraint,
  environment: NeutralMapperEnvironment,
): void {
  assertKnownKeys(
    config,
    instruction.src_ix_name,
    `fixed account ${constraint.index}`,
    constraint,
    [
      "index",
      "writable",
      "signer",
      "account",
      "one_of_accounts",
      "same_as",
      "dynamic_account",
    ],
  );
  const identities = [
    constraint.account !== undefined,
    constraint.one_of_accounts !== undefined,
    constraint.same_as !== undefined,
    constraint.dynamic_account !== undefined,
  ].filter(Boolean).length;
  if (identities > 1) {
    throw configError(
      config,
      instruction.src_ix_name,
      `fixed account ${constraint.index} has more than one identity constraint`,
    );
  }

  if (constraint.account !== undefined) {
    normalizeAddress(
      constraint.account,
      `fixed account ${constraint.index}`,
      environment,
    );
  }

  if (constraint.one_of_accounts !== undefined) {
    if (
      !Array.isArray(constraint.one_of_accounts) ||
      constraint.one_of_accounts.length === 0
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        `fixed account ${constraint.index} has an empty account allowlist`,
      );
    }
    const unique = new Set<string>();
    constraint.one_of_accounts.forEach((account) => {
      const canonical = normalizeAddress(
        account,
        `fixed account ${constraint.index} allowlist entry`,
        environment,
      );
      if (unique.has(canonical)) {
        throw configError(
          config,
          instruction.src_ix_name,
          `fixed account ${constraint.index} has a duplicate allowlisted address`,
        );
      }
      unique.add(canonical);
    });
  }

  if (constraint.same_as !== undefined) {
    if (
      !Number.isInteger(constraint.same_as) ||
      constraint.same_as < 0 ||
      constraint.same_as >= instruction.strict.fixed_accounts.length ||
      constraint.same_as === constraint.index
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        `fixed account ${constraint.index} has invalid same_as index ${constraint.same_as}`,
      );
    }
  }

  if (
    constraint.dynamic_account !== undefined &&
    !STRICT_DYNAMIC_ACCOUNT_NAMES.has(constraint.dynamic_account)
  ) {
    throw configError(
      config,
      instruction.src_ix_name,
      `fixed account ${constraint.index} has unknown dynamic identity "${constraint.dynamic_account}"`,
    );
  }
}

function validateStrictInstructionConfig(
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
  environment: NeutralMapperEnvironment,
): void {
  assertKnownKeys(config, instruction.src_ix_name, "instruction", instruction, [
    "src_ix_name",
    "src_discriminator",
    "dst_ix_name",
    "dst_discriminator",
    "dynamic_accounts",
    "static_accounts",
    "index_map",
    "program_id_placeholder_indices",
    "strict",
  ]);
  if (!instruction.src_ix_name || !instruction.dst_ix_name) {
    throw configError(
      config,
      instruction.src_ix_name,
      "source and destination instruction names are required",
    );
  }
  assertByteArray(
    config,
    instruction.src_ix_name,
    "src_discriminator",
    instruction.src_discriminator,
  );
  assertByteArray(
    config,
    instruction.src_ix_name,
    "dst_discriminator",
    instruction.dst_discriminator,
  );

  instruction.dynamic_accounts.forEach(({ name, index, writable, signer }) => {
    if (!STRICT_DYNAMIC_ACCOUNT_NAMES.has(name as StrictDynamicAccountName)) {
      throw configError(
        config,
        instruction.src_ix_name,
        `unknown dynamic account "${name}"`,
      );
    }
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      typeof writable !== "boolean" ||
      typeof signer !== "boolean"
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        `dynamic account "${name}" is malformed`,
      );
    }
  });
  instruction.dynamic_accounts.forEach((account) =>
    assertKnownKeys(
      config,
      instruction.src_ix_name,
      `dynamic account "${account.name}"`,
      account,
      ["name", "index", "writable", "signer"],
    ),
  );

  instruction.static_accounts.forEach(
    ({ account, index, writable, signer }) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        typeof writable !== "boolean" ||
        typeof signer !== "boolean"
      ) {
        throw configError(
          config,
          instruction.src_ix_name,
          `static account at destination index ${index} is malformed`,
        );
      }
      normalizeAddress(account, `static account ${index}`, environment);
    },
  );
  instruction.static_accounts.forEach((account) =>
    assertKnownKeys(
      config,
      instruction.src_ix_name,
      `static account ${account.index}`,
      account,
      ["account", "index", "writable", "signer"],
    ),
  );

  instruction.index_map.forEach((index) => {
    if (!Number.isInteger(index) || index < -1) {
      throw configError(
        config,
        instruction.src_ix_name,
        `index_map entry ${index} is invalid`,
      );
    }
  });
  assertDenseUniqueDestinationIndices(config, instruction);

  const { strict } = instruction;
  if (
    !strict ||
    !Number.isInteger(strict.data_length) ||
    strict.data_length < instruction.src_discriminator.length
  ) {
    throw configError(
      config,
      instruction.src_ix_name,
      "strict.data_length is invalid",
    );
  }
  assertKnownKeys(config, instruction.src_ix_name, "strict metadata", strict, [
    "data_length",
    "fixed_accounts",
    "remaining_accounts",
    "allowed_duplicate_privilege_pairs",
  ]);
  if (
    !Array.isArray(strict.fixed_accounts) ||
    strict.fixed_accounts.length !== instruction.index_map.length
  ) {
    throw configError(
      config,
      instruction.src_ix_name,
      `strict.fixed_accounts must contain exactly ${instruction.index_map.length} entries`,
    );
  }
  strict.fixed_accounts.forEach((constraint, expectedIndex) => {
    if (
      constraint.index !== expectedIndex ||
      typeof constraint.writable !== "boolean" ||
      typeof constraint.signer !== "boolean"
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        `fixed account constraints must be dense; entry ${expectedIndex} is malformed`,
      );
    }
    validateIdentityConstraint(config, instruction, constraint, environment);
  });
  const duplicatePairs = strict.allowed_duplicate_privilege_pairs ?? [];
  if (!Array.isArray(duplicatePairs)) {
    throw configError(
      config,
      instruction.src_ix_name,
      "allowed_duplicate_privilege_pairs must be an array",
    );
  }
  const seenDuplicatePairs = new Set<string>();
  duplicatePairs.forEach((pair) => {
    assertKnownKeys(
      config,
      instruction.src_ix_name,
      "allowed duplicate privilege pair",
      pair,
      ["index", "same_as"],
    );
    const key = `${String(pair.index)}:${String(pair.same_as)}`;
    if (
      !Number.isInteger(pair.index) ||
      !Number.isInteger(pair.same_as) ||
      pair.index <= pair.same_as ||
      pair.index >= strict.fixed_accounts.length ||
      strict.fixed_accounts[pair.index].same_as !== pair.same_as ||
      seenDuplicatePairs.has(key)
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        `allowed duplicate privilege pair ${key} is not an exact same_as constraint`,
      );
    }
    seenDuplicatePairs.add(key);
  });

  instruction.program_id_placeholder_indices?.forEach((index) => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= strict.fixed_accounts.length ||
      instruction.index_map[index] === -1
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        `program_id_placeholder_indices entry ${index} is invalid`,
      );
    }
  });

  const remaining = strict.remaining_accounts;
  if (
    !remaining ||
    (remaining.kind !== "none" && remaining.kind !== "paired_segments")
  ) {
    throw configError(
      config,
      instruction.src_ix_name,
      "strict.remaining_accounts has an unknown kind",
    );
  }
  assertKnownKeys(
    config,
    instruction.src_ix_name,
    "remaining-account rule",
    remaining,
    remaining.kind === "none"
      ? ["kind"]
      : ["kind", "first", "second", "min_per_segment", "max_per_segment"],
  );
  if (remaining.kind === "paired_segments") {
    assertKnownKeys(
      config,
      instruction.src_ix_name,
      "first remaining-account segment",
      remaining.first,
      ["writable", "signer"],
    );
    assertKnownKeys(
      config,
      instruction.src_ix_name,
      "second remaining-account segment",
      remaining.second,
      ["writable", "signer"],
    );
    const min = remaining.min_per_segment ?? 0;
    if (
      !Number.isSafeInteger(min) ||
      min < 0 ||
      !Number.isSafeInteger(remaining.max_per_segment) ||
      remaining.max_per_segment < min ||
      typeof remaining.first?.writable !== "boolean" ||
      typeof remaining.first?.signer !== "boolean" ||
      typeof remaining.second?.writable !== "boolean" ||
      typeof remaining.second?.signer !== "boolean"
    ) {
      throw configError(
        config,
        instruction.src_ix_name,
        "strict paired remaining-account bounds or metas are malformed",
      );
    }
  }
}

function discriminatorsOverlap(a: number[], b: number[]): boolean {
  const prefixLength = Math.min(a.length, b.length);
  for (let index = 0; index < prefixLength; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function equalOptionalAddressAllowlist(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((address, index) => address === sortedRight[index]);
}

function sameSafePassthroughShape(
  left: SafePassthroughInstructionClassification,
  right: SafePassthroughInstructionClassification,
): boolean {
  if (
    left.program_id !== right.program_id ||
    !bytesEqual(
      new Uint8Array(left.strict.data.bytes),
      new Uint8Array(right.strict.data.bytes),
    ) ||
    left.strict.fixed_accounts.length !== right.strict.fixed_accounts.length
  ) {
    return false;
  }
  return left.strict.fixed_accounts.every((constraint, index) => {
    const other = right.strict.fixed_accounts[index];
    return (
      constraint.index === other.index &&
      constraint.writable === other.writable &&
      constraint.signer === other.signer &&
      constraint.account === other.account &&
      equalOptionalAddressAllowlist(
        constraint.one_of_accounts,
        other.one_of_accounts,
      ) &&
      constraint.same_as === other.same_as &&
      constraint.dynamic_account === other.dynamic_account
    );
  });
}

/** Validate trusted, bundled schema-v2 configuration at module initialization. */
function validateStrictRemappingConfigs(
  configs: StrictRemappingConfigs,
  environment: NeutralMapperEnvironment,
): StrictRemappingConfigs {
  Object.entries(configs).forEach(([key, config]) => {
    assertKnownKeys(config, undefined, "configuration", config, [
      "schema_version",
      "config_revision",
      "program_id",
      "proxy_program_id",
      "instructions",
    ]);
    if (config.schema_version !== 2) {
      throw configError(config, undefined, "schema_version must be 2");
    }
    if (
      !Number.isSafeInteger(config.config_revision) ||
      config.config_revision < 1
    ) {
      throw configError(
        config,
        undefined,
        "config_revision must be a positive integer",
      );
    }
    const programId = normalizeAddress(
      config.program_id,
      "configuration program_id",
      environment,
    );
    if (key !== programId) {
      throw configError(
        config,
        undefined,
        `configuration key ${key} does not match program_id`,
      );
    }
    normalizeAddress(
      config.proxy_program_id,
      "configuration proxy_program_id",
      environment,
    );
    if (
      !Array.isArray(config.instructions) ||
      config.instructions.length === 0
    ) {
      throw configError(config, undefined, "instructions must not be empty");
    }
    config.instructions.forEach((instruction) =>
      validateStrictInstructionConfig(config, instruction, environment),
    );
    for (let left = 0; left < config.instructions.length; left += 1) {
      for (
        let right = left + 1;
        right < config.instructions.length;
        right += 1
      ) {
        if (
          discriminatorsOverlap(
            config.instructions[left].src_discriminator,
            config.instructions[right].src_discriminator,
          )
        ) {
          throw configError(
            config,
            config.instructions[right].src_ix_name,
            `source discriminator overlaps with ${config.instructions[left].src_ix_name}`,
          );
        }
      }
    }
  });

  return configs;
}

function classificationError(
  config: InstructionClassificationConfig,
  ruleId: string | undefined,
  message: string,
): Error {
  const location = ruleId
    ? `${config.integration}:${ruleId}`
    : config.integration;
  return new Error(
    `Invalid instruction classification ${location}: ${message}`,
  );
}

function assertClassificationKeys(
  config: InstructionClassificationConfig,
  ruleId: string | undefined,
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw classificationError(
      config,
      ruleId,
      `${label} has unknown field "${unknown.sort()[0]}"`,
    );
  }
}

function assertClassificationBytes(
  config: InstructionClassificationConfig,
  ruleId: string,
  label: string,
  bytes: number[],
): void {
  if (!Array.isArray(bytes) || bytes.length === 0 || bytes.length > 1232) {
    throw classificationError(
      config,
      ruleId,
      `${label} must contain 1..1232 bytes`,
    );
  }
  bytes.forEach((byte, index) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw classificationError(
        config,
        ruleId,
        `${label}[${index}] is not a byte`,
      );
    }
  });
}

function validatePassthroughRule(
  config: InstructionClassificationConfig,
  rule: SafePassthroughInstructionClassification,
  environment: NeutralMapperEnvironment,
): void {
  assertClassificationKeys(config, rule.id, "safe-passthrough rule", rule, [
    "id",
    "outcome",
    "program_id",
    "instruction",
    "phase",
    "emitted_by",
    "condition",
    "discriminator",
    "rationale",
    "strict",
  ]);
  assertClassificationBytes(
    config,
    rule.id,
    "discriminator",
    rule.discriminator,
  );
  if (typeof rule.rationale !== "string" || rule.rationale.trim().length < 8) {
    throw classificationError(
      config,
      rule.id,
      "safe passthrough requires a substantive rationale",
    );
  }
  if (!rule.strict || typeof rule.strict !== "object") {
    throw classificationError(config, rule.id, "strict policy is required");
  }
  assertClassificationKeys(config, rule.id, "strict policy", rule.strict, [
    "data",
    "fixed_accounts",
    "remaining_accounts",
  ]);
  if (
    !rule.strict.data ||
    rule.strict.data.kind !== "exact" ||
    !Array.isArray(rule.strict.data.bytes)
  ) {
    throw classificationError(
      config,
      rule.id,
      "strict.data must be an exact byte constraint",
    );
  }
  assertClassificationKeys(
    config,
    rule.id,
    "data constraint",
    rule.strict.data,
    ["kind", "bytes"],
  );
  assertClassificationBytes(
    config,
    rule.id,
    "strict.data.bytes",
    rule.strict.data.bytes,
  );
  if (
    !rule.discriminator.every(
      (byte, index) => rule.strict.data.bytes[index] === byte,
    )
  ) {
    throw classificationError(
      config,
      rule.id,
      "exact data does not start with the reviewed discriminator",
    );
  }
  if (
    !rule.strict.remaining_accounts ||
    rule.strict.remaining_accounts.kind !== "none" ||
    Object.keys(rule.strict.remaining_accounts).length !== 1
  ) {
    throw classificationError(
      config,
      rule.id,
      "safe passthrough cannot accept remaining accounts",
    );
  }
  if (
    !Array.isArray(rule.strict.fixed_accounts) ||
    rule.strict.fixed_accounts.length > 256
  ) {
    throw classificationError(
      config,
      rule.id,
      "fixed account policy must be a bounded array",
    );
  }
  rule.strict.fixed_accounts.forEach((constraint, expectedIndex) => {
    assertClassificationKeys(
      config,
      rule.id,
      `fixed account ${expectedIndex}`,
      constraint,
      [
        "index",
        "writable",
        "signer",
        "account",
        "one_of_accounts",
        "same_as",
        "dynamic_account",
      ],
    );
    if (
      constraint.index !== expectedIndex ||
      typeof constraint.writable !== "boolean" ||
      typeof constraint.signer !== "boolean"
    ) {
      throw classificationError(
        config,
        rule.id,
        `fixed account ${expectedIndex} is not dense or has invalid roles`,
      );
    }
    const identities = [
      constraint.account !== undefined,
      constraint.one_of_accounts !== undefined,
      constraint.same_as !== undefined,
      constraint.dynamic_account !== undefined,
    ].filter(Boolean).length;
    if (identities !== 1) {
      throw classificationError(
        config,
        rule.id,
        `fixed account ${expectedIndex} requires exactly one identity constraint`,
      );
    }
    if (constraint.account !== undefined) {
      normalizeAddress(
        constraint.account,
        `safe-passthrough account ${expectedIndex}`,
        environment,
      );
    }
    if (constraint.one_of_accounts !== undefined) {
      if (
        !Array.isArray(constraint.one_of_accounts) ||
        constraint.one_of_accounts.length === 0
      ) {
        throw classificationError(
          config,
          rule.id,
          `fixed account ${expectedIndex} has an empty address allowlist`,
        );
      }
      const addresses = constraint.one_of_accounts.map((address) =>
        normalizeAddress(
          address,
          `safe-passthrough account ${expectedIndex}`,
          environment,
        ),
      );
      if (new Set(addresses).size !== addresses.length) {
        throw classificationError(
          config,
          rule.id,
          `fixed account ${expectedIndex} has duplicate allowlisted addresses`,
        );
      }
    }
    if (
      constraint.same_as !== undefined &&
      (!Number.isInteger(constraint.same_as) ||
        constraint.same_as < 0 ||
        constraint.same_as >= expectedIndex)
    ) {
      throw classificationError(
        config,
        rule.id,
        `fixed account ${expectedIndex} has an invalid same_as constraint`,
      );
    }
    if (
      constraint.dynamic_account !== undefined &&
      (constraint.dynamic_account === "integration_authority" ||
        !STRICT_DYNAMIC_ACCOUNT_NAMES.has(constraint.dynamic_account))
    ) {
      throw classificationError(
        config,
        rule.id,
        `fixed account ${expectedIndex} has an invalid native binding`,
      );
    }
  });
}

/** Validate the versioned, exhaustive instruction classification profile. */
function validateInstructionClassificationConfig(
  config: InstructionClassificationConfig,
  mappings: StrictRemappingConfigs,
  environment: NeutralMapperEnvironment,
): InstructionClassificationConfig {
  assertClassificationKeys(config, undefined, "configuration", config, [
    "$schema",
    "schema_version",
    "config_revision",
    "integration",
    "rules",
  ]);
  if (
    (config.$schema !== undefined && typeof config.$schema !== "string") ||
    config.schema_version !== 1 ||
    !Number.isSafeInteger(config.config_revision) ||
    config.config_revision < 1 ||
    typeof config.integration !== "string" ||
    config.integration.trim().length === 0 ||
    !Array.isArray(config.rules) ||
    config.rules.length === 0
  ) {
    throw classificationError(config, undefined, "configuration is malformed");
  }

  const ids = new Set<string>();
  const mappedReferences = new Set<string>();
  const safeRules: SafePassthroughInstructionClassification[] = [];
  config.rules.forEach((rule) => {
    if (
      !rule ||
      typeof rule.id !== "string" ||
      rule.id.trim().length === 0 ||
      ids.has(rule.id)
    ) {
      throw classificationError(
        config,
        rule?.id,
        "rule ID is missing or duplicated",
      );
    }
    ids.add(rule.id);
    const programAddress = normalizeAddress(
      rule.program_id,
      `classification ${rule.id} program`,
      environment,
    );
    if (
      programAddress !== rule.program_id ||
      typeof rule.instruction !== "string" ||
      rule.instruction.trim().length === 0 ||
      !["protocol", "setup", "cleanup"].includes(rule.phase) ||
      !Array.isArray(rule.emitted_by) ||
      rule.emitted_by.length === 0 ||
      rule.emitted_by.some(
        (emitter) => typeof emitter !== "string" || emitter.trim().length === 0,
      ) ||
      typeof rule.condition !== "string" ||
      rule.condition.trim().length === 0
    ) {
      throw classificationError(
        config,
        rule.id,
        "common rule fields are malformed",
      );
    }

    if (rule.outcome === "mapped") {
      assertClassificationKeys(config, rule.id, "mapped rule", rule, [
        "id",
        "outcome",
        "program_id",
        "instruction",
        "phase",
        "emitted_by",
        "condition",
        "discriminator",
        "mapping_ref",
      ]);
      assertClassificationBytes(
        config,
        rule.id,
        "discriminator",
        rule.discriminator,
      );
      assertClassificationKeys(
        config,
        rule.id,
        "mapping reference",
        rule.mapping_ref,
        ["config_schema_version", "config_revision", "source_instruction"],
      );
      const mappingConfig = mappings[programAddress];
      const mapped = mappingConfig?.instructions.find(
        ({ src_ix_name }) =>
          src_ix_name === rule.mapping_ref.source_instruction,
      );
      if (
        !mappingConfig ||
        rule.mapping_ref.config_schema_version !==
          mappingConfig.schema_version ||
        rule.mapping_ref.config_revision !== mappingConfig.config_revision ||
        !mapped ||
        mapped.src_ix_name !== rule.instruction ||
        !bytesEqual(
          new Uint8Array(mapped.src_discriminator),
          new Uint8Array(rule.discriminator),
        )
      ) {
        throw classificationError(
          config,
          rule.id,
          "mapped rule does not resolve to the pinned mapping configuration",
        );
      }
      const mappingReference = `${programAddress}:${mapped.src_ix_name}`;
      if (mappedReferences.has(mappingReference)) {
        throw classificationError(
          config,
          rule.id,
          "mapped rule duplicates another mapping reference",
        );
      }
      mappedReferences.add(mappingReference);
      return;
    }

    if (rule.outcome === "safePassthrough") {
      validatePassthroughRule(config, rule, environment);
      safeRules.push(rule);
      return;
    }

    if (rule.outcome === "unsupported") {
      assertClassificationKeys(config, rule.id, "unsupported rule", rule, [
        "id",
        "outcome",
        "program_id",
        "instruction",
        "phase",
        "emitted_by",
        "condition",
        "discriminator",
        "reason",
      ]);
      if (rule.discriminator !== undefined) {
        assertClassificationBytes(
          config,
          rule.id,
          "discriminator",
          rule.discriminator,
        );
      }
      if (typeof rule.reason !== "string" || rule.reason.trim().length < 8) {
        throw classificationError(
          config,
          rule.id,
          "unsupported rule requires a substantive reason",
        );
      }
      return;
    }

    throw classificationError(
      config,
      (rule as { id?: string }).id,
      "rule outcome is unknown",
    );
  });

  for (const current of safeRules) {
    const mappingConfig = mappings[current.program_id];
    const overlappingMapping = mappingConfig?.instructions.find((instruction) =>
      discriminatorsOverlap(
        current.discriminator,
        instruction.src_discriminator,
      ),
    );
    if (overlappingMapping) {
      throw classificationError(
        config,
        current.id,
        `passthrough discriminator overlaps mapped ${overlappingMapping.src_ix_name}`,
      );
    }
    for (const other of safeRules) {
      if (other.id !== current.id && sameSafePassthroughShape(current, other)) {
        throw classificationError(
          config,
          current.id,
          `passthrough shape duplicates ${other.id}`,
        );
      }
    }
  }

  const mappedRules = config.rules.filter((rule) => rule.outcome === "mapped");
  const mappingCount = Object.values(mappings).reduce(
    (count, mapping) => count + mapping.instructions.length,
    0,
  );
  if (mappedRules.length !== mappingCount) {
    throw classificationError(
      config,
      undefined,
      "every strict mapping must have exactly one mapped classification",
    );
  }

  return config;
}

function unsupported(
  reason: UnsupportedInstructionReason,
  message: string,
): UnsupportedInstructionResult {
  return { kind: "unsupported", reason, message };
}

function isInstructionShape(
  instruction: NeutralInstruction,
  environment: NeutralMapperEnvironment,
): boolean {
  try {
    if (
      !instruction ||
      !Array.isArray(instruction.accounts) ||
      !(instruction.data instanceof Uint8Array)
    ) {
      return false;
    }
    normalizeAddress(instruction.programAddress, "program", environment);
    return instruction.accounts.every((meta, index) => {
      normalizeAddress(meta?.address, `account ${index}`, environment);
      return isAccountRole(meta?.role);
    });
  } catch {
    return false;
  }
}

function conflictingDuplicatePrivileges(
  instruction: Pick<NeutralInstruction, "programAddress" | "accounts">,
  allowedPairs: readonly { readonly index: number; readonly same_as: number }[] = [],
): string | undefined {
  const seen = new Map<string, { role: number; position: string; index: number }>();
  seen.set(instruction.programAddress, { role: 0, position: "program ID", index: -1 });
  const allowed = new Set(
    allowedPairs.map(({ index, same_as }) => `${String(index)}:${String(same_as)}`),
  );

  for (let index = 0; index < instruction.accounts.length; index += 1) {
    const meta = instruction.accounts[index];
    const previous = seen.get(meta.address);
    if (
      previous &&
      previous.role !== meta.role &&
      !allowed.has(`${String(index)}:${String(previous.index)}`)
    ) {
      return `account ${index} duplicates ${previous.position} with different signer or writable privileges`;
    }
    if (!previous) {
      seen.set(meta.address, {
        role: meta.role,
        position: `account ${index}`,
        index,
      });
    }
  }
  return undefined;
}

function dynamicAccounts(
  context: NeutralMappingContext,
  proxyProgramAddress: string,
  environment: NeutralMapperEnvironment,
): Record<StrictDynamicAccountName, string> {
  if (
    typeof context !== "object" ||
    context === null ||
    typeof context.integrationAuthorityByProxyProgram !== "object" ||
    context.integrationAuthorityByProxyProgram === null ||
    Array.isArray(context.integrationAuthorityByProxyProgram)
  ) {
    throw new TypeError("Mapping context is malformed");
  }
  const authorityEntries = Object.entries(
    context.integrationAuthorityByProxyProgram,
  );
  if (authorityEntries.length > 64) {
    throw new RangeError("Mapping context contains too many proxy authorities");
  }
  const authorities = new Map<string, string>();
  for (const [proxy, authority] of authorityEntries) {
    const normalizedProxy = normalizeAddress(
      proxy,
      "proxy program",
      environment,
    );
    if (authorities.has(normalizedProxy)) {
      throw new TypeError("Mapping context contains a duplicate proxy program");
    }
    authorities.set(
      normalizedProxy,
      normalizeAddress(authority, "integration authority", environment),
    );
  }
  const integrationAuthority = authorities.get(proxyProgramAddress);
  if (!integrationAuthority) {
    throw new TypeError(
      `Mapping context is missing integration authority for ${proxyProgramAddress}`,
    );
  }

  return {
    glam_state: normalizeAddress(
      context.glamStateAddress,
      "GLAM state",
      environment,
    ),
    glam_vault: normalizeAddress(
      context.glamVaultAddress,
      "GLAM vault",
      environment,
    ),
    glam_signer: normalizeAddress(
      context.glamSignerAddress,
      "GLAM signer",
      environment,
    ),
    integration_authority: integrationAuthority,
  };
}

function nativeDynamicAccounts(
  context: NeutralMappingContext,
  environment: NeutralMapperEnvironment,
): Record<Exclude<StrictDynamicAccountName, "integration_authority">, string> {
  return {
    glam_state: normalizeAddress(
      context.glamStateAddress,
      "GLAM state",
      environment,
    ),
    glam_vault: normalizeAddress(
      context.glamVaultAddress,
      "GLAM vault",
      environment,
    ),
    glam_signer: normalizeAddress(
      context.glamSignerAddress,
      "GLAM signer",
      environment,
    ),
  };
}

function validateSafePassthroughAccounts(
  source: NeutralInstruction,
  rule: SafePassthroughInstructionClassification,
  context: NeutralMappingContext,
  environment: NeutralMapperEnvironment,
): UnsupportedInstructionResult | undefined {
  const constraints = rule.strict.fixed_accounts;
  if (source.accounts.length !== constraints.length) {
    return unsupported(
      "account-count",
      `${rule.instruction} requires exactly ${constraints.length} accounts; received ${source.accounts.length}`,
    );
  }
  const dynamic = nativeDynamicAccounts(context, environment);
  for (const constraint of constraints) {
    const meta = source.accounts[constraint.index];
    if (meta.role !== roleFromFlags(constraint.writable, constraint.signer)) {
      return unsupported(
        "account-meta",
        `${rule.instruction} account ${constraint.index} has unexpected signer or writable privileges`,
      );
    }
    if (
      constraint.account !== undefined &&
      meta.address !==
        normalizeAddress(
          constraint.account,
          `safe-passthrough account ${constraint.index}`,
          environment,
        )
    ) {
      return unsupported(
        "account-address",
        `${rule.instruction} account ${constraint.index} has an unexpected address`,
      );
    }
    if (
      constraint.one_of_accounts !== undefined &&
      !constraint.one_of_accounts.some(
        (address) =>
          meta.address ===
          normalizeAddress(
            address,
            `safe-passthrough account ${constraint.index}`,
            environment,
          ),
      )
    ) {
      return unsupported(
        "account-address",
        `${rule.instruction} account ${constraint.index} is not allowlisted`,
      );
    }
    if (
      constraint.same_as !== undefined &&
      meta.address !== source.accounts[constraint.same_as].address
    ) {
      return unsupported(
        "account-address",
        `${rule.instruction} account ${constraint.index} does not match account ${constraint.same_as}`,
      );
    }
    if (
      constraint.dynamic_account !== undefined &&
      constraint.dynamic_account !== "integration_authority" &&
      meta.address !== dynamic[constraint.dynamic_account]
    ) {
      return unsupported(
        "account-address",
        `${rule.instruction} account ${constraint.index} does not match ${constraint.dynamic_account}`,
      );
    }
  }
  return undefined;
}

function validateFixedAccounts(
  source: NeutralInstruction,
  instruction: StrictInstruction,
  dynamic: Record<StrictDynamicAccountName, string>,
  environment: NeutralMapperEnvironment,
): UnsupportedInstructionResult | undefined {
  const fixedCount = instruction.strict.fixed_accounts.length;
  if (source.accounts.length < fixedCount) {
    return unsupported(
      "account-count",
      `${instruction.src_ix_name} requires ${fixedCount} fixed accounts; received ${source.accounts.length}`,
    );
  }

  for (const constraint of instruction.strict.fixed_accounts) {
    const meta = source.accounts[constraint.index];
    const expectedRole = roleFromFlags(constraint.writable, constraint.signer);
    if (meta.role !== expectedRole) {
      return unsupported(
        "account-meta",
        `${instruction.src_ix_name} account ${constraint.index} has unexpected signer or writable privileges`,
      );
    }

    if (
      constraint.account !== undefined &&
      meta.address !==
        normalizeAddress(
          constraint.account,
          `fixed account ${constraint.index}`,
          environment,
        )
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} has an unexpected address`,
      );
    }
    if (
      constraint.one_of_accounts !== undefined &&
      !constraint.one_of_accounts.some(
        (account) =>
          meta.address ===
          normalizeAddress(
            account,
            `fixed account ${constraint.index} allowlist entry`,
            environment,
          ),
      )
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} is not in its address allowlist`,
      );
    }
    if (
      constraint.same_as !== undefined &&
      meta.address !== source.accounts[constraint.same_as].address
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} does not match account ${constraint.same_as}`,
      );
    }
    if (
      constraint.dynamic_account !== undefined &&
      meta.address !== dynamic[constraint.dynamic_account]
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} does not match ${constraint.dynamic_account}`,
      );
    }
  }
  return undefined;
}

function validateRemainingAccounts(
  source: NeutralInstruction,
  instruction: StrictInstruction,
): UnsupportedInstructionResult | undefined {
  const fixedCount = instruction.strict.fixed_accounts.length;
  const remaining = source.accounts.slice(fixedCount);
  const rule = instruction.strict.remaining_accounts;

  if (rule.kind === "none") {
    return remaining.length === 0
      ? undefined
      : unsupported(
          "account-count",
          `${instruction.src_ix_name} does not accept remaining accounts`,
        );
  }
  if (remaining.length % 2 !== 0) {
    return unsupported(
      "remaining-accounts",
      `${instruction.src_ix_name} requires two equal remaining-account segments`,
    );
  }
  const segmentLength = remaining.length / 2;
  const min = rule.min_per_segment ?? 0;
  if (segmentLength < min || segmentLength > rule.max_per_segment) {
    return unsupported(
      "remaining-accounts",
      `${instruction.src_ix_name} remaining-account segment length ${segmentLength} is outside ${min}..${rule.max_per_segment}`,
    );
  }

  const firstRole = roleFromFlags(rule.first.writable, rule.first.signer);
  const secondRole = roleFromFlags(rule.second.writable, rule.second.signer);
  for (let index = 0; index < segmentLength; index += 1) {
    if (
      remaining[index].role !== firstRole ||
      remaining[index + segmentLength].role !== secondRole
    ) {
      return unsupported(
        "remaining-accounts",
        `${instruction.src_ix_name} remaining account ${index} violates its segment privileges`,
      );
    }
  }
  return undefined;
}

function equalMeta(
  actual: NeutralAccountMeta | undefined,
  expected: NeutralAccountMeta,
): boolean {
  return (
    actual !== undefined &&
    actual.address === expected.address &&
    actual.role === expected.role
  );
}

function validateDestination(
  output: NeutralInstruction,
  source: NeutralInstruction,
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
  dynamic: Record<StrictDynamicAccountName, string>,
  environment: NeutralMapperEnvironment,
): UnsupportedInstructionResult | undefined {
  const proxyProgramAddress = normalizeAddress(
    config.proxy_program_id,
    "proxy program",
    environment,
  );
  if (output.programAddress !== proxyProgramAddress) {
    return unsupported(
      "destination-invariant",
      `${instruction.dst_ix_name} has an unexpected destination program`,
    );
  }

  const privilegeConflict = conflictingDuplicatePrivileges(output);
  if (privilegeConflict) {
    return unsupported(
      "destination-invariant",
      `${instruction.dst_ix_name} ${privilegeConflict}`,
    );
  }

  const expectedData = concatBytes(
    instruction.dst_discriminator,
    source.data.slice(instruction.src_discriminator.length),
  );
  if (!bytesEqual(output.data, expectedData)) {
    return unsupported(
      "destination-invariant",
      `${instruction.dst_ix_name} data does not preserve the audited payload`,
    );
  }

  const fixedDestinationCount =
    instruction.dynamic_accounts.length +
    instruction.static_accounts.length +
    instruction.index_map.filter((index) => index !== -1).length;
  const remaining = source.accounts.slice(
    instruction.strict.fixed_accounts.length,
  );
  if (output.accounts.length !== fixedDestinationCount + remaining.length) {
    return unsupported(
      "destination-invariant",
      `${instruction.dst_ix_name} produced an unexpected account count`,
    );
  }

  for (const account of instruction.dynamic_accounts) {
    const expected: NeutralAccountMeta = {
      address: dynamic[account.name as StrictDynamicAccountName],
      role: roleFromFlags(account.writable, account.signer),
    };
    if (!equalMeta(output.accounts[account.index], expected)) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} dynamic account ${account.index} changed`,
      );
    }
  }
  for (const account of instruction.static_accounts) {
    const expected: NeutralAccountMeta = {
      address: normalizeAddress(
        account.account,
        `static account ${account.index}`,
        environment,
      ),
      role: roleFromFlags(account.writable, account.signer),
    };
    if (!equalMeta(output.accounts[account.index], expected)) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} static account ${account.index} changed`,
      );
    }
  }

  const placeholderIndices = new Set(
    instruction.program_id_placeholder_indices ?? [],
  );
  for (
    let sourceIndex = 0;
    sourceIndex < instruction.index_map.length;
    sourceIndex += 1
  ) {
    const destinationIndex = instruction.index_map[sourceIndex];
    if (destinationIndex === -1) continue;
    const sourceMeta = source.accounts[sourceIndex];
    const expected: NeutralAccountMeta = {
      address:
        placeholderIndices.has(sourceIndex) &&
        sourceMeta.address === source.programAddress
          ? proxyProgramAddress
          : sourceMeta.address,
      role: sourceMeta.role,
    };
    if (!equalMeta(output.accounts[destinationIndex], expected)) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} mapped account ${destinationIndex} changed`,
      );
    }
  }
  for (let index = 0; index < remaining.length; index += 1) {
    if (
      !equalMeta(
        output.accounts[fixedDestinationCount + index],
        remaining[index],
      )
    ) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} remaining account ${index} changed`,
      );
    }
  }
  return undefined;
}

function buildMappedInstruction(
  source: NeutralInstruction,
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
  dynamic: Record<StrictDynamicAccountName, string>,
  environment: NeutralMapperEnvironment,
): NeutralInstruction {
  const proxyProgramAddress = normalizeAddress(
    config.proxy_program_id,
    "proxy program",
    environment,
  );
  const accountMetasByIndex = new Map<number, NeutralAccountMeta>();

  instruction.dynamic_accounts.forEach(({ name, index, writable, signer }) => {
    accountMetasByIndex.set(index, {
      address: dynamic[name as StrictDynamicAccountName],
      role: roleFromFlags(writable, signer),
    });
  });
  instruction.static_accounts.forEach(
    ({ account, index, writable, signer }) => {
      accountMetasByIndex.set(index, {
        address: normalizeAddress(
          account,
          `static account ${index}`,
          environment,
        ),
        role: roleFromFlags(writable, signer),
      });
    },
  );

  const placeholderIndices = new Set(
    instruction.program_id_placeholder_indices ?? [],
  );
  const fixedCount = instruction.strict.fixed_accounts.length;
  for (let sourceIndex = 0; sourceIndex < fixedCount; sourceIndex += 1) {
    const destinationIndex = instruction.index_map[sourceIndex];
    if (destinationIndex === -1) continue;
    const meta = source.accounts[sourceIndex];
    accountMetasByIndex.set(destinationIndex, {
      address:
        placeholderIndices.has(sourceIndex) &&
        meta.address === source.programAddress
          ? proxyProgramAddress
          : meta.address,
      role: meta.role,
    });
  }

  const fixedDestination = [...accountMetasByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, meta]) => ({ ...meta }));
  const remaining = source.accounts
    .slice(fixedCount)
    .map((meta) => ({ ...meta }));

  return {
    programAddress: proxyProgramAddress,
    accounts: [...fixedDestination, ...remaining],
    data: concatBytes(
      instruction.dst_discriminator,
      source.data.slice(instruction.src_discriminator.length),
    ),
  };
}

/** Map one canonical instruction using only audited schema-v2 configuration. */
function mapInstructionWithConfigs(
  source: NeutralInstruction,
  context: NeutralMappingContext,
  configs: StrictRemappingConfigs,
  classifications: InstructionClassificationConfig,
  environment: NeutralMapperEnvironment,
): NeutralMapInstructionResult {
  try {
    if (!isInstructionShape(source, environment)) {
      return unsupported(
        "invalid-instruction",
        "Instruction is missing a valid program, data, or account roles",
      );
    }

    const config = configs[source.programAddress];
    const instruction = config?.instructions.find(({ src_discriminator }) =>
      bytesStartWith(source.data, src_discriminator),
    );
    if (!instruction) {
      const safeCandidates = classifications.rules.filter(
        (rule): rule is SafePassthroughInstructionClassification =>
          rule.outcome === "safePassthrough" &&
          rule.program_id === source.programAddress &&
          bytesStartWith(source.data, rule.discriminator),
      );
      if (safeCandidates.length > 0) {
        const exactDataCandidates = safeCandidates.filter((candidate) =>
          bytesEqual(source.data, new Uint8Array(candidate.strict.data.bytes)),
        );
        if (exactDataCandidates.length === 0) {
          return unsupported(
            "invalid-data",
            `${safeCandidates[0].instruction} data does not match any exact reviewed allowlist`,
          );
        }
        const privilegeConflict = conflictingDuplicatePrivileges(source);
        if (privilegeConflict) {
          return unsupported(
            "account-meta",
            `${exactDataCandidates[0].instruction} ${privilegeConflict}`,
          );
        }
        let firstAccountFailure: UnsupportedInstructionResult | undefined;
        for (const safeRule of exactDataCandidates) {
          const accountFailure = validateSafePassthroughAccounts(
            source,
            safeRule,
            context,
            environment,
          );
          if (accountFailure) {
            firstAccountFailure ??= accountFailure;
            continue;
          }
          return {
            kind: "safePassthrough",
            instruction: {
              programAddress: source.programAddress,
              accounts: source.accounts.map((account) => ({ ...account })),
              data: source.data.slice(),
            },
            sourceInstructionName: safeRule.instruction,
          };
        }
        return firstAccountFailure!;
      }
      if (!config) {
        return unsupported(
          "unsupported-program",
          `Program ${source.programAddress} has no audited mapping or passthrough rule`,
        );
      }
      return unsupported(
        "unsupported-instruction",
        `Program ${source.programAddress} instruction discriminator is not supported`,
      );
    }
    if (source.data.length !== instruction.strict.data_length) {
      return unsupported(
        "invalid-data",
        `${instruction.src_ix_name} requires exactly ${instruction.strict.data_length} data bytes; received ${source.data.length}`,
      );
    }

    const privilegeConflict = conflictingDuplicatePrivileges(
      source,
      instruction.strict.allowed_duplicate_privilege_pairs,
    );
    if (privilegeConflict) {
      return unsupported(
        "account-meta",
        `${instruction.src_ix_name} ${privilegeConflict}`,
      );
    }

    const proxyProgramAddress = normalizeAddress(
      config.proxy_program_id,
      "proxy program",
      environment,
    );
    const dynamic = dynamicAccounts(context, proxyProgramAddress, environment);
    const fixedFailure = validateFixedAccounts(
      source,
      instruction,
      dynamic,
      environment,
    );
    if (fixedFailure) return fixedFailure;
    const remainingFailure = validateRemainingAccounts(source, instruction);
    if (remainingFailure) return remainingFailure;

    const output = buildMappedInstruction(
      source,
      config,
      instruction,
      dynamic,
      environment,
    );
    const destinationFailure = validateDestination(
      output,
      source,
      config,
      instruction,
      dynamic,
      environment,
    );
    if (destinationFailure) return destinationFailure;

    return {
      kind: "mapped",
      instruction: output,
      sourceInstructionName: instruction.src_ix_name,
      destinationInstructionName: instruction.dst_ix_name,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return unsupported(
      "invalid-instruction",
      `Instruction could not be mapped safely: ${message}`,
    );
  }
}

export {
  mapInstructionWithConfigs,
  validateInstructionClassificationConfig,
  validateStrictRemappingConfigs,
};
