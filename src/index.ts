import {
  AccountMeta,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import * as SystemProgramConfig from "../mapping-configs-v1/11111111111111111111111111111111.json";
import * as TokenProgramConfig from "../mapping-configs-v1/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.json";
import * as Token2022ProgramConfig from "../mapping-configs-v1/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json";
import * as DriftProtocolProgramConfig from "../mapping-configs-v1/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH.json";
import * as DriftVaultProgramConfig from "../mapping-configs-v1/vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR.json";
import * as KaminoLendProgramConfig from "../mapping-configs-v1/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.json";
import * as KvauGMspProgramConfig from "../mapping-configs-v1/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import * as FarmsProgramConfig from "../mapping-configs-v1/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";

import * as StagingSystemProgramConfig from "../mapping-configs-v1-staging/11111111111111111111111111111111.json";
import * as StagingTokenProgramConfig from "../mapping-configs-v1-staging/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.json";
import * as StagingToken2022ProgramConfig from "../mapping-configs-v1-staging/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json";
import * as StagingDriftProtocolProgramConfig from "../mapping-configs-v1-staging/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH.json";
import * as StagingDriftVaultProgramConfig from "../mapping-configs-v1-staging/vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR.json";
import * as StagingKaminoLendProgramConfig from "../mapping-configs-v1-staging/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.json";
import * as StagingKvauGMspProgramConfig from "../mapping-configs-v1-staging/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import * as StagingFarmsProgramConfig from "../mapping-configs-v1-staging/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";

import { RemappingConfigs, RemappingConfig } from "./types";
import { getIntegrationAuthority, getVaultPda } from "./pda";

/**
 * Production remapping configurations indexed by program ID
 */
const REMAPPING_CONFIGS: RemappingConfigs = {
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
};

/**
 * Staging remapping configurations indexed by program ID
 */
const STAGING_REMAPPING_CONFIGS: RemappingConfigs = {
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
};

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
  const accountMetasByIndex = new Map<Number, AccountMeta>();

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

  console.assert(
    ix.keys.length >= ixConfig.index_map.length,
    "ix.keys length must be greater than or equal to ixConfig.index_map length",
  );

  const remainingAccountMetas = [] as AccountMeta[];
  for (let i = 0; i < ix.keys.length; i++) {
    if (i < ixConfig.index_map.length) {
      if (ixConfig.index_map[i] === -1) {
        continue;
      }
      const { pubkey, isSigner, isWritable } = ix.keys[i];
      accountMetasByIndex.set(ixConfig.index_map[i], {
        pubkey,
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

export { mapToGlamIx, fixSignerAccounts };
