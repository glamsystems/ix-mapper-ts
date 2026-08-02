import {
  type AccountMeta,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import { getIntegrationAuthority, getVaultPda } from "./pda";
import {
  type MapInstructionResult,
  type StrictAccountConstraint,
  type StrictDynamicAccountName,
  type StrictInstruction,
  type StrictRemappingConfig,
  type StrictRemappingConfigs,
  type UnsupportedInstructionReason,
  type UnsupportedInstructionResult,
} from "./types";

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
    new PublicKey(constraint.account);
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
      const canonical = new PublicKey(account).toBase58();
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
      new PublicKey(account);
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
    validateIdentityConstraint(config, instruction, constraint);
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
      : [
          "kind",
          "first",
          "second",
          "min_per_segment",
          "max_per_segment",
        ],
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

/** Validate trusted, bundled schema-v2 configuration at module initialization. */
function validateStrictRemappingConfigs(
  configs: StrictRemappingConfigs,
): StrictRemappingConfigs {
  Object.entries(configs).forEach(([key, config]) => {
    assertKnownKeys(config, undefined, "configuration", config, [
      "schema_version",
      "program_id",
      "proxy_program_id",
      "instructions",
    ]);
    if (config.schema_version !== 2) {
      throw configError(config, undefined, "schema_version must be 2");
    }
    const programId = new PublicKey(config.program_id).toBase58();
    if (key !== programId) {
      throw configError(
        config,
        undefined,
        `configuration key ${key} does not match program_id`,
      );
    }
    new PublicKey(config.proxy_program_id);
    if (!Array.isArray(config.instructions) || config.instructions.length === 0) {
      throw configError(config, undefined, "instructions must not be empty");
    }
    config.instructions.forEach((instruction) =>
      validateStrictInstructionConfig(config, instruction),
    );
    for (let left = 0; left < config.instructions.length; left += 1) {
      for (let right = left + 1; right < config.instructions.length; right += 1) {
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

function unsupported(
  reason: UnsupportedInstructionReason,
  message: string,
): UnsupportedInstructionResult {
  return { kind: "unsupported", reason, message };
}

function isInstructionShape(ix: TransactionInstruction): boolean {
  if (
    !ix ||
    !ix.programId ||
    typeof ix.programId.toBase58 !== "function" ||
    !Array.isArray(ix.keys) ||
    !(ix.data instanceof Uint8Array)
  ) {
    return false;
  }
  return ix.keys.every(
    (meta) =>
      meta &&
      meta.pubkey &&
      typeof meta.pubkey.equals === "function" &&
      typeof meta.isSigner === "boolean" &&
      typeof meta.isWritable === "boolean",
  );
}

function conflictingDuplicatePrivileges(
  ix: Pick<TransactionInstruction, "programId" | "keys">,
): string | undefined {
  const seen = new Map<
    string,
    { isSigner: boolean; isWritable: boolean; position: string }
  >();
  seen.set(ix.programId.toBase58(), {
    isSigner: false,
    isWritable: false,
    position: "program ID",
  });

  for (let index = 0; index < ix.keys.length; index += 1) {
    const meta = ix.keys[index];
    const key = meta.pubkey.toBase58();
    const previous = seen.get(key);
    if (
      previous &&
      (previous.isSigner !== meta.isSigner ||
        previous.isWritable !== meta.isWritable)
    ) {
      return `account ${index} duplicates ${previous.position} with different signer or writable privileges`;
    }
    if (!previous) {
      seen.set(key, {
        isSigner: meta.isSigner,
        isWritable: meta.isWritable,
        position: `account ${index}`,
      });
    }
  }

  return undefined;
}

function dynamicAccounts(
  glamState: PublicKey,
  glamSigner: PublicKey,
  proxyProgramId: PublicKey,
  staging: boolean,
): Record<StrictDynamicAccountName, PublicKey> {
  return {
    glam_state: glamState,
    glam_vault: getVaultPda(glamState, staging),
    glam_signer: glamSigner,
    integration_authority: getIntegrationAuthority(proxyProgramId),
  };
}

function validateFixedAccounts(
  ix: TransactionInstruction,
  instruction: StrictInstruction,
  dynamic: Record<StrictDynamicAccountName, PublicKey>,
): UnsupportedInstructionResult | undefined {
  const fixedCount = instruction.strict.fixed_accounts.length;
  if (ix.keys.length < fixedCount) {
    return unsupported(
      "account-count",
      `${instruction.src_ix_name} requires ${fixedCount} fixed accounts; received ${ix.keys.length}`,
    );
  }

  for (const constraint of instruction.strict.fixed_accounts) {
    const meta = ix.keys[constraint.index];
    if (
      meta.isSigner !== constraint.signer ||
      meta.isWritable !== constraint.writable
    ) {
      return unsupported(
        "account-meta",
        `${instruction.src_ix_name} account ${constraint.index} has unexpected signer or writable privileges`,
      );
    }

    if (
      constraint.account !== undefined &&
      !meta.pubkey.equals(new PublicKey(constraint.account))
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} has an unexpected address`,
      );
    }
    if (
      constraint.one_of_accounts !== undefined &&
      !constraint.one_of_accounts.some((account) =>
        meta.pubkey.equals(new PublicKey(account)),
      )
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} is not in its address allowlist`,
      );
    }
    if (
      constraint.same_as !== undefined &&
      !meta.pubkey.equals(ix.keys[constraint.same_as].pubkey)
    ) {
      return unsupported(
        "account-address",
        `${instruction.src_ix_name} account ${constraint.index} does not match account ${constraint.same_as}`,
      );
    }
    if (
      constraint.dynamic_account !== undefined &&
      !meta.pubkey.equals(dynamic[constraint.dynamic_account])
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
  ix: TransactionInstruction,
  instruction: StrictInstruction,
): UnsupportedInstructionResult | undefined {
  const fixedCount = instruction.strict.fixed_accounts.length;
  const remaining = ix.keys.slice(fixedCount);
  const rule = instruction.strict.remaining_accounts;

  if (rule.kind === "none") {
    if (remaining.length !== 0) {
      return unsupported(
        "account-count",
        `${instruction.src_ix_name} does not accept remaining accounts`,
      );
    }
    return undefined;
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

  for (let index = 0; index < segmentLength; index += 1) {
    const first = remaining[index];
    const second = remaining[index + segmentLength];
    if (
      first.isSigner !== rule.first.signer ||
      first.isWritable !== rule.first.writable ||
      second.isSigner !== rule.second.signer ||
      second.isWritable !== rule.second.writable
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
  actual: AccountMeta | undefined,
  expected: AccountMeta,
): boolean {
  return (
    actual !== undefined &&
    actual.pubkey.equals(expected.pubkey) &&
    actual.isSigner === expected.isSigner &&
    actual.isWritable === expected.isWritable
  );
}

function validateDestination(
  output: TransactionInstruction,
  source: TransactionInstruction,
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
  dynamic: Record<StrictDynamicAccountName, PublicKey>,
): UnsupportedInstructionResult | undefined {
  const proxyProgramId = new PublicKey(config.proxy_program_id);
  if (!output.programId.equals(proxyProgramId)) {
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

  const sourcePayload = source.data.subarray(
    instruction.src_discriminator.length,
  );
  const expectedData = Buffer.from([
    ...instruction.dst_discriminator,
    ...sourcePayload,
  ]);
  if (!output.data.equals(expectedData)) {
    return unsupported(
      "destination-invariant",
      `${instruction.dst_ix_name} data does not preserve the audited payload`,
    );
  }

  const fixedDestinationCount =
    instruction.dynamic_accounts.length +
    instruction.static_accounts.length +
    instruction.index_map.filter((index) => index !== -1).length;
  const remaining = source.keys.slice(instruction.strict.fixed_accounts.length);
  if (output.keys.length !== fixedDestinationCount + remaining.length) {
    return unsupported(
      "destination-invariant",
      `${instruction.dst_ix_name} produced an unexpected account count`,
    );
  }

  for (const account of instruction.dynamic_accounts) {
    const expected: AccountMeta = {
      pubkey: dynamic[account.name as StrictDynamicAccountName],
      isSigner: account.signer,
      isWritable: account.writable,
    };
    if (!equalMeta(output.keys[account.index], expected)) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} dynamic account ${account.index} changed`,
      );
    }
  }
  for (const account of instruction.static_accounts) {
    const expected: AccountMeta = {
      pubkey: new PublicKey(account.account),
      isSigner: account.signer,
      isWritable: account.writable,
    };
    if (!equalMeta(output.keys[account.index], expected)) {
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
    if (destinationIndex === -1) {
      continue;
    }
    const sourceMeta = source.keys[sourceIndex];
    const expected: AccountMeta = {
      pubkey:
        placeholderIndices.has(sourceIndex) &&
        sourceMeta.pubkey.equals(source.programId)
          ? proxyProgramId
          : sourceMeta.pubkey,
      isSigner: sourceMeta.isSigner,
      isWritable: sourceMeta.isWritable,
    };
    if (!equalMeta(output.keys[destinationIndex], expected)) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} mapped account ${destinationIndex} changed`,
      );
    }
  }

  for (let index = 0; index < remaining.length; index += 1) {
    if (!equalMeta(output.keys[fixedDestinationCount + index], remaining[index])) {
      return unsupported(
        "destination-invariant",
        `${instruction.dst_ix_name} remaining account ${index} changed`,
      );
    }
  }

  return undefined;
}

function buildMappedInstruction(
  source: TransactionInstruction,
  config: StrictRemappingConfig,
  instruction: StrictInstruction,
  dynamic: Record<StrictDynamicAccountName, PublicKey>,
): TransactionInstruction {
  const proxyProgramId = new PublicKey(config.proxy_program_id);
  const accountMetasByIndex = new Map<number, AccountMeta>();

  instruction.dynamic_accounts.forEach(({ name, index, writable, signer }) => {
    accountMetasByIndex.set(index, {
      pubkey: dynamic[name as StrictDynamicAccountName],
      isSigner: signer,
      isWritable: writable,
    });
  });
  instruction.static_accounts.forEach(
    ({ account, index, writable, signer }) => {
      accountMetasByIndex.set(index, {
        pubkey: new PublicKey(account),
        isSigner: signer,
        isWritable: writable,
      });
    },
  );

  const placeholderIndices = new Set(
    instruction.program_id_placeholder_indices ?? [],
  );
  const fixedCount = instruction.strict.fixed_accounts.length;
  for (let sourceIndex = 0; sourceIndex < fixedCount; sourceIndex += 1) {
    const destinationIndex = instruction.index_map[sourceIndex];
    if (destinationIndex === -1) {
      continue;
    }
    const meta = source.keys[sourceIndex];
    accountMetasByIndex.set(destinationIndex, {
      pubkey:
        placeholderIndices.has(sourceIndex) &&
        meta.pubkey.equals(source.programId)
          ? proxyProgramId
          : meta.pubkey,
      isSigner: meta.isSigner,
      isWritable: meta.isWritable,
    });
  }

  const fixedDestination = [...accountMetasByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, meta]) => meta);
  const remaining = source.keys.slice(fixedCount).map((meta) => ({
    pubkey: meta.pubkey,
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  }));
  const payload = source.data.subarray(instruction.src_discriminator.length);

  return new TransactionInstruction({
    programId: proxyProgramId,
    keys: [...fixedDestination, ...remaining],
    data: Buffer.from([...instruction.dst_discriminator, ...payload]),
  });
}

/** Map one instruction using only audited schema-v2 configuration. */
function mapInstructionWithConfigs(
  ix: TransactionInstruction,
  glamState: PublicKey,
  glamSigner: PublicKey,
  configs: StrictRemappingConfigs,
  staging: boolean,
): MapInstructionResult {
  try {
    if (!isInstructionShape(ix)) {
      return unsupported(
        "invalid-instruction",
        "Instruction is missing a valid program, data buffer, or account metas",
      );
    }

    const programId = ix.programId.toBase58();
    const config = configs[programId];
    if (!config) {
      return unsupported(
        "unsupported-program",
        `Program ${programId} has no audited schema-v2 mapping`,
      );
    }

    const instruction = config.instructions.find(({ src_discriminator }) =>
      ix.data
        .subarray(0, src_discriminator.length)
        .equals(Buffer.from(src_discriminator)),
    );
    if (!instruction) {
      return unsupported(
        "unsupported-instruction",
        `Program ${programId} instruction discriminator is not supported`,
      );
    }
    if (ix.data.length !== instruction.strict.data_length) {
      return unsupported(
        "invalid-data",
        `${instruction.src_ix_name} requires exactly ${instruction.strict.data_length} data bytes; received ${ix.data.length}`,
      );
    }

    const privilegeConflict = conflictingDuplicatePrivileges(ix);
    if (privilegeConflict) {
      return unsupported(
        "account-meta",
        `${instruction.src_ix_name} ${privilegeConflict}`,
      );
    }

    const proxyProgramId = new PublicKey(config.proxy_program_id);
    const dynamic = dynamicAccounts(
      glamState,
      glamSigner,
      proxyProgramId,
      staging,
    );
    const fixedFailure = validateFixedAccounts(ix, instruction, dynamic);
    if (fixedFailure) {
      return fixedFailure;
    }
    const remainingFailure = validateRemainingAccounts(ix, instruction);
    if (remainingFailure) {
      return remainingFailure;
    }

    const output = buildMappedInstruction(ix, config, instruction, dynamic);
    const destinationFailure = validateDestination(
      output,
      ix,
      config,
      instruction,
      dynamic,
    );
    if (destinationFailure) {
      return destinationFailure;
    }

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

export { mapInstructionWithConfigs, validateStrictRemappingConfigs };
