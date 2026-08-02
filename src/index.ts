import {
  type AccountMeta,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import SystemProgramConfig from "../mapping-configs-v1/11111111111111111111111111111111.json";
import TokenProgramConfig from "../mapping-configs-v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.json";
import Token2022ProgramConfig from "../mapping-configs-v1/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json";
import DriftProtocolProgramConfig from "../mapping-configs-v1/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH.json";
import DriftVaultProgramConfig from "../mapping-configs-v1/vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR.json";
import KaminoLendProgramConfig from "../mapping-configs-v1/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.json";
import KvauGMspProgramConfig from "../mapping-configs-v1/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import FarmsProgramConfig from "../mapping-configs-v1/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";

import StagingSystemProgramConfig from "../mapping-configs-v1-staging/11111111111111111111111111111111.json";
import StagingTokenProgramConfig from "../mapping-configs-v1-staging/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.json";
import StagingToken2022ProgramConfig from "../mapping-configs-v1-staging/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json";
import StagingDriftProtocolProgramConfig from "../mapping-configs-v1-staging/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH.json";
import StagingDriftVaultProgramConfig from "../mapping-configs-v1-staging/vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR.json";
import StagingKaminoLendProgramConfig from "../mapping-configs-v1-staging/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.json";
import StagingKvauGMspProgramConfig from "../mapping-configs-v1-staging/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import StagingFarmsProgramConfig from "../mapping-configs-v1-staging/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";
import StagingLoopscaleProgramConfig from "../mapping-configs-v1-staging/1oopBoJG58DgkUVKkEzKgyG9dvRmpgeEm1AVjoHkF78.json";
// Staging-only proxies (no mainnet v1 counterpart yet)
import StagingPhoenixProgramConfig from "../mapping-configs-v1-staging/EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih.json";
import StagingEmberProgramConfig from "../mapping-configs-v1-staging/EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy.json";

import StrictKvauGMspProgramConfig from "../mapping-configs-v2/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import StrictStagingKvauGMspProgramConfig from "../mapping-configs-v2-staging/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";

import {
  type Instruction as RemappingInstruction,
  type MappableInstruction,
  type RemappingConfigs,
  type RemappingConfig,
  type MapInstructionOptions,
  type MapInstructionResult,
  type StrictRemappingConfig,
  type StrictRemappingConfigs,
} from "./types";
import { getIntegrationAuthority, getVaultPda } from "./pda";
import {
  mapInstructionWithConfigs,
  validateStrictRemappingConfigs,
} from "./strict";

const DYNAMIC_ACCOUNT_NAMES = new Set([
  "glam_state",
  "glam_vault",
  "glam_signer",
  "integration_authority",
]);

function assertDenseUniqueIndices(label: string, indices: number[]): void {
  const seen = new Set<number>();
  const sorted = [...indices].sort((a, b) => a - b);

  sorted.forEach((index) => {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`${label} contains an invalid account index: ${index}`);
    }
    if (seen.has(index)) {
      throw new Error(`${label} contains a duplicate account index: ${index}`);
    }
    seen.add(index);
  });

  sorted.forEach((index, expectedIndex) => {
    if (index !== expectedIndex) {
      throw new Error(
        `${label} must form a dense range starting at 0, but found ${index} at position ${expectedIndex}`,
      );
    }
  });
}

function validateInstructionConfig(
  config: RemappingConfig,
  ixConfig: RemappingInstruction,
): void {
  ixConfig.dynamic_accounts.forEach(({ name, index }) => {
    if (!DYNAMIC_ACCOUNT_NAMES.has(name)) {
      throw new Error(
        `Unknown dynamic account "${name}" in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Invalid dynamic account index ${index} in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
  });

  ixConfig.static_accounts.forEach(({ account, index }) => {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Invalid static account index ${index} in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
    new PublicKey(account);
  });

  ixConfig.index_map.forEach((index) => {
    if (!Number.isInteger(index) || index < -1) {
      throw new Error(
        `Invalid index_map entry ${index} in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
  });

  ixConfig.program_id_placeholder_indices?.forEach((index) => {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Invalid program_id_placeholder_indices entry ${index} in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
    if (index >= ixConfig.index_map.length) {
      throw new Error(
        `program_id_placeholder_indices entry ${index} is out of bounds in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
    if (ixConfig.index_map[index] === -1) {
      throw new Error(
        `program_id_placeholder_indices entry ${index} maps to -1 in ${config.program_id}:${ixConfig.src_ix_name}`,
      );
    }
  });

  assertDenseUniqueIndices(`${config.program_id}:${ixConfig.src_ix_name}`, [
    ...ixConfig.dynamic_accounts.map(({ index }) => index),
    ...ixConfig.static_accounts.map(({ index }) => index),
    ...ixConfig.index_map.filter((index) => index !== -1),
  ]);
}

function validateRemappingConfigs(configs: RemappingConfigs): RemappingConfigs {
  Object.values(configs).forEach((config) => {
    new PublicKey(config.program_id);
    new PublicKey(config.proxy_program_id);
    config.instructions.forEach((ixConfig) =>
      validateInstructionConfig(config, ixConfig),
    );
  });

  return configs;
}

/**
 * Production remapping configurations indexed by program ID
 */
const REMAPPING_CONFIGS: RemappingConfigs = validateRemappingConfigs({
  [SystemProgramConfig.program_id]: SystemProgramConfig as RemappingConfig,
  [TokenProgramConfig.program_id]: TokenProgramConfig as RemappingConfig,
  [Token2022ProgramConfig.program_id]:
    Token2022ProgramConfig as RemappingConfig,
  [DriftProtocolProgramConfig.program_id]:
    DriftProtocolProgramConfig as RemappingConfig,
  [DriftVaultProgramConfig.program_id]:
    DriftVaultProgramConfig as RemappingConfig,
  [KaminoLendProgramConfig.program_id]:
    KaminoLendProgramConfig as RemappingConfig,
  [KvauGMspProgramConfig.program_id]: KvauGMspProgramConfig as RemappingConfig,
  [FarmsProgramConfig.program_id]: FarmsProgramConfig as RemappingConfig,
});

/**
 * Staging remapping configurations indexed by program ID
 */
const STAGING_REMAPPING_CONFIGS: RemappingConfigs = validateRemappingConfigs({
  [StagingSystemProgramConfig.program_id]:
    StagingSystemProgramConfig as RemappingConfig,
  [StagingTokenProgramConfig.program_id]:
    StagingTokenProgramConfig as RemappingConfig,
  [StagingToken2022ProgramConfig.program_id]:
    StagingToken2022ProgramConfig as RemappingConfig,
  [StagingDriftProtocolProgramConfig.program_id]:
    StagingDriftProtocolProgramConfig as RemappingConfig,
  [StagingDriftVaultProgramConfig.program_id]:
    StagingDriftVaultProgramConfig as RemappingConfig,
  [StagingKaminoLendProgramConfig.program_id]:
    StagingKaminoLendProgramConfig as RemappingConfig,
  [StagingKvauGMspProgramConfig.program_id]:
    StagingKvauGMspProgramConfig as RemappingConfig,
  [StagingFarmsProgramConfig.program_id]:
    StagingFarmsProgramConfig as RemappingConfig,
  [StagingLoopscaleProgramConfig.program_id]:
    StagingLoopscaleProgramConfig as RemappingConfig,
  [StagingPhoenixProgramConfig.program_id]:
    StagingPhoenixProgramConfig as RemappingConfig,
  [StagingEmberProgramConfig.program_id]:
    StagingEmberProgramConfig as RemappingConfig,
});

/**
 * Production mappings whose complete source layouts have been audited against
 * schema v2. The strict API never falls back to the v1 configuration set.
 */
const STRICT_REMAPPING_CONFIGS: StrictRemappingConfigs =
  validateStrictRemappingConfigs({
    [StrictKvauGMspProgramConfig.program_id]:
      StrictKvauGMspProgramConfig as StrictRemappingConfig,
  });

/** Staging counterparts to the audited production schema-v2 mappings. */
const STRICT_STAGING_REMAPPING_CONFIGS: StrictRemappingConfigs =
  validateStrictRemappingConfigs({
    [StrictStagingKvauGMspProgramConfig.program_id]:
      StrictStagingKvauGMspProgramConfig as StrictRemappingConfig,
  });

function isWeb3Instruction(
  instruction: MappableInstruction,
): instruction is TransactionInstruction {
  if (typeof instruction !== "object" || instruction === null) return false;
  const candidate = instruction as Partial<TransactionInstruction>;
  return (
    typeof candidate.programId?.toBase58 === "function" &&
    Array.isArray(candidate.keys) &&
    candidate.data instanceof Uint8Array
  );
}

function normalizeByteData(data: ArrayLike<number> | undefined): Buffer {
  if (
    data === undefined ||
    !Number.isSafeInteger(data.length) ||
    data.length < 0 ||
    data.length > 1232
  ) {
    throw new TypeError(
      "Instruction data must be a bounded byte-array value",
    );
  }
  const bytes = Array.from({ length: data.length }, (_, index) => data[index]);
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TypeError("Instruction data contains a non-byte value");
  }
  return Buffer.from(bytes);
}

/** Normalize a web3.js or Solana Kit-shaped instruction to web3.js. */
function normalizeInstruction(
  instruction: MappableInstruction,
): TransactionInstruction {
  if (isWeb3Instruction(instruction)) {
    const keys = instruction.keys.map((account, index) => {
      if (
        typeof account?.pubkey?.toBase58 !== "function" ||
        typeof account.isSigner !== "boolean" ||
        typeof account.isWritable !== "boolean"
      ) {
        throw new TypeError(`web3.js account ${index} is malformed`);
      }
      return {
        pubkey: new PublicKey(account.pubkey.toBase58()),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      };
    });
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId.toBase58()),
      keys,
      data: normalizeByteData(instruction.data),
    });
  }
  if (
    typeof instruction !== "object" ||
    instruction === null ||
    typeof instruction.programAddress !== "string"
  ) {
    throw new TypeError(
      "Solana Kit instruction requires a program address and byte data",
    );
  }

  const accounts = instruction.accounts ?? [];
  const keys = accounts.map((account, index) => {
    if (
      typeof account?.address !== "string" ||
      !Number.isInteger(account.role) ||
      account.role < 0 ||
      account.role > 3
    ) {
      throw new TypeError(`Solana Kit account ${index} is malformed`);
    }
    return {
      pubkey: new PublicKey(account.address),
      isSigner: (account.role & 2) !== 0,
      isWritable: (account.role & 1) !== 0,
    };
  });

  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys,
    data: normalizeByteData(instruction.data),
  });
}

/**
 * Applies remapping config and transforms ix into a GLAM ix
 */
function mapToGlamIx(
  ix: TransactionInstruction,
  glamState: PublicKey,
  glamSigner: PublicKey,
  staging = false,
): TransactionInstruction | null {
  const configs = staging ? STAGING_REMAPPING_CONFIGS : REMAPPING_CONFIGS;
  const config = configs[ix.programId.toBase58()];
  if (!config) {
    return null;
  }

  // Find the matching instruction in the config
  const ixConfig = config.instructions.find(({ src_discriminator }) => {
    return ix.data
      .subarray(0, src_discriminator.length)
      .equals(new Uint8Array(src_discriminator));
  });
  if (!ixConfig) {
    // No remapping config found for the incoming instruction. This happens when
    // 1. The instruction is not supported
    // 2. The instruction doesn't need to be remapped (e.g., it's permissionless and doesn't need to be signed by GLAM vault PDA)
    return null;
  }

  const proxyProgramId = new PublicKey(config.proxy_program_id);
  const accountMetasByIndex = new Map<number, AccountMeta>();

  // We need to build the array of keys for the new ix
  // `dynamic_accounts`
  //   - `glam_state`: input `glamState`
  //   - `glam_vault`: derived from `glamState`
  //   - `glam_signer`: input `glamSigner`
  //   - `integration_authority`: derived from `proxyProgramId`
  // `static_accounts`
  // `ix.keys`
  //   - for ix.keys[i], if ixConfig.index_map[i] is -1, drop it

  ixConfig.dynamic_accounts.forEach(({ name, index, writable, signer }) => {
    if (name === "glam_state") {
      accountMetasByIndex.set(index, {
        pubkey: glamState,
        isSigner: signer,
        isWritable: writable,
      });
    } else if (name === "glam_vault") {
      accountMetasByIndex.set(index, {
        pubkey: getVaultPda(glamState, staging),
        isSigner: signer,
        isWritable: writable,
      });
    } else if (name === "glam_signer") {
      accountMetasByIndex.set(index, {
        pubkey: glamSigner,
        isSigner: signer,
        isWritable: writable,
      });
    } else if (name === "integration_authority") {
      accountMetasByIndex.set(index, {
        pubkey: getIntegrationAuthority(proxyProgramId),
        isSigner: signer,
        isWritable: writable,
      });
    } else {
      throw new Error(`Unknown dynamic account at index ${index}: ${name}`);
    }
  });

  ixConfig.static_accounts.forEach(({ index, account, writable, signer }) => {
    accountMetasByIndex.set(index, {
      pubkey: new PublicKey(account),
      isSigner: signer,
      isWritable: writable,
    });
  });

  if (ix.keys.length < ixConfig.index_map.length) {
    throw new RangeError(
      `Instruction ${config.program_id}:${ixConfig.src_ix_name} requires at least ${ixConfig.index_map.length} accounts, received ${ix.keys.length}`,
    );
  }

  const srcProgramId = ix.programId;
  const placeholderIndices = new Set(
    ixConfig.program_id_placeholder_indices ?? [],
  );
  const remainingAccountMetas = [] as AccountMeta[];
  for (let i = 0; i < ix.keys.length; i++) {
    if (i < ixConfig.index_map.length) {
      if (ixConfig.index_map[i] === -1) {
        continue;
      }
      const { pubkey, isSigner, isWritable } = ix.keys[i];
      // When a protocol SDK passes its own program ID as a placeholder for
      // optional accounts (e.g. Kamino uses KLend program ID for None),
      // replace it with the proxy program ID so that Anchor's optional
      // account detection recognizes it as None.
      const mappedPubkey =
        placeholderIndices.has(i) && pubkey.equals(srcProgramId)
          ? proxyProgramId
          : pubkey;
      accountMetasByIndex.set(ixConfig.index_map[i], {
        pubkey: mappedPubkey,
        isSigner,
        isWritable,
      });
    } else {
      // if `i` is beyond the ixConfig.index_map length, it's a remaining account, add it as-is
      remainingAccountMetas.push(ix.keys[i]);
    }
  }

  // Replace src_discriminator with dst_discriminator in ix.data to get new ix data
  const payload = ix.data.subarray(ixConfig.src_discriminator.length); // remove the discriminator
  const targetIxData = Buffer.from([...ixConfig.dst_discriminator, ...payload]); // add new discriminator before payload

  // The final account metas for the new ix are:
  // accountMetasByIndex.values() sorted by index
  // remainingAccountMetas
  const accountMetas = [
    ...[...accountMetasByIndex.entries()]
      .sort(([a], [b]) => (a as number) - (b as number))
      .map(([_, meta]) => meta),
    ...remainingAccountMetas,
  ];

  return new TransactionInstruction({
    programId: proxyProgramId,
    keys: accountMetas,
    data: targetIxData,
  });
}

/**
 * Fail-closed instruction mapping using only audited schema-v2 layouts.
 *
 * Unlike `mapToGlamIx`, this API distinguishes mapped, explicitly safe
 * passthrough, and unsupported instructions. Unknown programs, unknown
 * discriminators, and malformed source layouts are always unsupported.
 */
function mapInstruction(
  ix: MappableInstruction,
  glamState: PublicKey,
  glamSigner: PublicKey,
  options: MapInstructionOptions | boolean = {},
): MapInstructionResult {
  const staging =
    typeof options === "boolean" ? options : (options?.staging ?? false);
  let normalized: TransactionInstruction;
  try {
    normalized = normalizeInstruction(ix);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      kind: "unsupported",
      reason: "invalid-instruction",
      message: `Instruction could not be normalized safely: ${message}`,
    };
  }
  return mapInstructionWithConfigs(
    normalized,
    glamState,
    glamSigner,
    staging ? STRICT_STAGING_REMAPPING_CONFIGS : STRICT_REMAPPING_CONFIGS,
    staging,
  );
}

/** Map an ordered instruction sequence without dropping unsupported entries. */
function mapInstructions(
  instructions: readonly MappableInstruction[],
  glamState: PublicKey,
  glamSigner: PublicKey,
  options: MapInstructionOptions | boolean = {},
): MapInstructionResult[] {
  return instructions.map((instruction) =>
    mapInstruction(instruction, glamState, glamSigner, options),
  );
}

/**
 * Replace vault PDA with glamSigner wherever the vault appears as a signer.
 * The vault PDA can't sign at the transaction level — only the on-chain program
 * can sign for it via CPI. This fixes accounts like fee_payer (InitObligation)
 * and ATA creation payer that the protocol SDK sets to the vault.
 */
function fixSignerAccounts(
  ix: TransactionInstruction,
  glamState: PublicKey,
  glamSigner: PublicKey,
  staging = false,
): TransactionInstruction {
  const vaultPda = getVaultPda(glamState, staging);
  const fixedKeys = ix.keys.map((meta) => {
    if (meta.pubkey.equals(vaultPda) && meta.isSigner) {
      return { ...meta, pubkey: glamSigner };
    }
    return meta;
  });
  return new TransactionInstruction({
    programId: ix.programId,
    keys: fixedKeys,
    data: ix.data,
  });
}

export {
  fixSignerAccounts,
  mapInstruction,
  mapInstructions,
  mapToGlamIx,
  normalizeInstruction,
};
export type {
  MappableInstruction,
  MapInstructionOptions,
  MapInstructionResult,
  MappedInstructionResult,
  SafePassthroughInstructionResult,
  SolanaKitAccountMeta,
  SolanaKitAccountRole,
  SolanaKitInstruction,
  StrictAccountConstraint,
  StrictDynamicAccountName,
  StrictInstruction,
  StrictInstructionMetadata,
  StrictNoRemainingAccounts,
  StrictPairedRemainingAccounts,
  StrictRemainingAccountMeta,
  StrictRemainingAccounts,
  StrictRemappingConfig,
  StrictRemappingConfigs,
  UnsupportedInstructionReason,
  UnsupportedInstructionResult,
} from "./types";
