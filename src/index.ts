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
        pubkey: getVaultPda(glamState),
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
      // if `i` is beyond the ixConfig.index_map length, it's a remaining account
      remainingAccountMetas.push(ix.keys[i]);
    }
  }

  // Replace src_discriminator with dst_discriminator in ix.data to get new ix data
  const payload = ix.data.subarray(ixConfig.src_discriminator.length);
  const targetIxData = Buffer.from([...ixConfig.dst_discriminator, ...payload]);

  // The final account metas for the new ix are:
  // accountMetasByIndex.values() sorted by index
  // remainingAccountMetas
  const accountMetas = [
    ...[...accountMetasByIndex.entries()].sort().map(([_, meta]) => meta),
    ...remainingAccountMetas,
  ];

  return new TransactionInstruction({
    programId: proxyProgramId,
    keys: accountMetas,
    data: targetIxData,
  });
}

export { mapToGlamIx };
