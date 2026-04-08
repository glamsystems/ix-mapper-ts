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
import { RemappingConfigs, RemappingConfig } from "./types";
import { getIntegrationAuthority, getVaultPda } from "./pda";

/**
 * All remapping configurations indexed by program ID
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
};

/**
 * Applies remapping config and transforms ix into a GLAM ix
 */
function mapToGlamIx(
  ix: TransactionInstruction,
  glamState: PublicKey,
  glamSigner: PublicKey,
): TransactionInstruction | null {
  const config = REMAPPING_CONFIGS[ix.programId.toBase58()];
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
    return null;
  }

  const proxyProgramId = new PublicKey(config.proxy_program_id);
  const accountMetas = [] as AccountMeta[];

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
      accountMetas.push({
        pubkey: glamState,
        isSigner: signer,
        isWritable: writable,
      });
    } else if (name === "glam_vault") {
      accountMetas.push({
        pubkey: getVaultPda(glamState),
        isSigner: signer,
        isWritable: writable,
      });
    } else if (name === "glam_signer") {
      accountMetas.push({
        pubkey: glamSigner,
        isSigner: signer,
        isWritable: writable,
      });
    } else if (name === "integration_authority") {
      accountMetas.push({
        pubkey: getIntegrationAuthority(proxyProgramId),
        isSigner: signer,
        isWritable: writable,
      });
    } else {
      throw new Error(`Unknown dynamic account at index ${index}: ${name}`);
    }
  });

  ixConfig.static_accounts.forEach(({ account, writable, signer }) => {
    accountMetas.push({
      pubkey: new PublicKey(account),
      isSigner: signer,
      isWritable: writable,
    });
  });

  for (let i = 0; i < ix.keys.length; i++) {
    if (i < ixConfig.index_map.length && ixConfig.index_map[i] === -1) {
      continue;
    }

    const { pubkey, isSigner, isWritable } = ix.keys[i];
    accountMetas.push({
      pubkey,
      isSigner,
      isWritable,
    });
  }

  // Replace src_discriminator with dst_discriminator in ix.data to get new ix data
  const payload = ix.data.subarray(ixConfig.src_discriminator.length);
  const targetIxData = Buffer.from([...ixConfig.dst_discriminator, ...payload]);

  return new TransactionInstruction({
    programId: proxyProgramId,
    keys: accountMetas,
    data: targetIxData,
  });
}

export { mapToGlamIx };
