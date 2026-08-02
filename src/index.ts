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
  type RemappingConfigs,
  type RemappingConfig,
  type MapInstructionOptions,
  type MapInstructionResult,
  type NeutralMapInstructionResult,
  type NeutralMappingContext,
} from "./types";
import { createNeutralMapper } from "./core";
import {
  normalizeLegacyInstruction,
  toWeb3Instruction,
  type MappableInstruction,
} from "./legacy-web3";
import { getIntegrationAuthority, getVaultPda } from "./pda";

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

const WEB3_MAPPER_ENVIRONMENT = {
  normalizeAddress(address: string): string {
    return new PublicKey(address).toBase58();
  },
};

const neutralMapper = createNeutralMapper(WEB3_MAPPER_ENVIRONMENT);

/** Normalize a Kit-shaped or web3.js instruction to a fresh web3.js object. */
function normalizeInstruction(
  instruction: MappableInstruction,
): TransactionInstruction {
  return toWeb3Instruction(
    normalizeLegacyInstruction(instruction, WEB3_MAPPER_ENVIRONMENT),
  );
}

function toWeb3Result(
  result: NeutralMapInstructionResult,
): MapInstructionResult {
  if (result.kind === "unsupported") return result;
  return { ...result, instruction: toWeb3Instruction(result.instruction) };
}

function parseLegacyOptions(
  options: MapInstructionOptions | boolean,
): MapInstructionOptions {
  if (typeof options === "boolean") return { staging: options };
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("Mapper options must be a boolean or object");
  }
  const unknown = Object.keys(options).filter((key) => key !== "staging");
  if (unknown.length > 0) {
    throw new TypeError(`Unknown mapper option: ${unknown.sort()[0]}`);
  }
  if (options.staging !== undefined && typeof options.staging !== "boolean") {
    throw new TypeError("Mapper staging option must be boolean");
  }
  return options;
}

function createWeb3MappingContext(
  glamState: PublicKey,
  glamSigner: PublicKey,
  staging: boolean,
): NeutralMappingContext {
  const productionProxy = new PublicKey(
    StrictKvauGMspProgramConfig.proxy_program_id,
  );
  const stagingProxy = new PublicKey(
    StrictStagingKvauGMspProgramConfig.proxy_program_id,
  );
  return {
    glamStateAddress: glamState.toBase58(),
    glamVaultAddress: getVaultPda(glamState, staging).toBase58(),
    glamSignerAddress: glamSigner.toBase58(),
    integrationAuthorityByProxyProgram: {
      [productionProxy.toBase58()]:
        getIntegrationAuthority(productionProxy).toBase58(),
      [stagingProxy.toBase58()]:
        getIntegrationAuthority(stagingProxy).toBase58(),
    },
  };
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
    // Legacy nullable API: null means no v1 mapping exists. It is not approval
    // to pass an instruction through. New code must use mapInstruction(), which
    // returns an explicit fail-closed tagged result.
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
  try {
    const parsedOptions = parseLegacyOptions(options);
    const context = createWeb3MappingContext(
      glamState,
      glamSigner,
      parsedOptions.staging ?? false,
    );
    return toWeb3Result(
      neutralMapper.mapInstructionNeutral(
        normalizeLegacyInstruction(ix, WEB3_MAPPER_ENVIRONMENT),
        context,
        parsedOptions,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      kind: "unsupported",
      reason: "invalid-instruction",
      message: `Instruction could not be normalized safely: ${message}`,
    };
  }
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
export type { MappableInstruction } from "./legacy-web3";
