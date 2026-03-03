/**
 * ix-mapper Demo: Kamino USDC Deposit via GLAM Vault
 *
 * Demonstrates the ix-mapper value proposition:
 *   1. Use Kamino's official klend-sdk to build raw deposit instructions
 *   2. Pass each instruction through mapToGlamIx() to wrap them for GLAM vault execution
 *   3. Simulate the resulting transaction on mainnet
 *
 * Usage:
 *   cp .env.example .env   # fill in RPC URL, wallet path, GLAM_STATE
 *   pnpm install && pnpm dev
 */

import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { mapToGlamIx, fixSignerAccounts } from "@glamsystems/ix-mapper";
import {
  createSolanaRpc,
  type Address,
  type TransactionSigner,
  type Instruction as KitInstruction,
} from "@solana/kit";
import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";

// ─── Constants ───────────────────────────────────────────────────────────────

const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KAMINO_LENDING_PROGRAM = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);
const KAMINO_FARM_PROGRAM = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const COMPUTE_BUDGET_PROGRAM = new PublicKey(
  "ComputeBudget111111111111111111111111111111",
);
const GLAM_PROGRAM_ID = new PublicKey(
  "GLAMpaME8wdTEzxtiYEAa5yD8fZbxZiz2hNtV58RZiEz",
);
const GLAM_STAGING_PROGRAM_ID = new PublicKey(
  "gstgptmbgJVi5f8ZmSRVZjZkDQwqKa3xWuUtD5WmJHz",
);
const EXT_KAMINO_PROXY = new PublicKey(
  "G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde",
);
const STAGING_EXT_KAMINO_PROXY = new PublicKey(
  "gstgKa2Gq9wf5hM3DFWx1TvUrGYzDYszyFGq3XBY9Uq",
);

// ─── Staging toggle ─────────────────────────────────────────────────────────

const STAGING = (process.env.GLAM_STAGING ?? "true").toLowerCase() === "true";

// ─── PDA Derivation ──────────────────────────────────────────────────────────

function getGlamProgramId(): PublicKey {
  return STAGING ? GLAM_STAGING_PROGRAM_ID : GLAM_PROGRAM_ID;
}

function getExtKaminoProxy(): PublicKey {
  return STAGING ? STAGING_EXT_KAMINO_PROXY : EXT_KAMINO_PROXY;
}

function getVaultPda(statePda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), statePda.toBuffer()],
    getGlamProgramId(),
  );
  return pda;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

const PROGRAM_NAMES: Record<string, string> = {
  [KAMINO_LENDING_PROGRAM.toBase58()]: "Kamino Lending",
  [KAMINO_FARM_PROGRAM.toBase58()]: "Kamino Farms",
  [ASSOCIATED_TOKEN_PROGRAM.toBase58()]: "Associated Token",
  [COMPUTE_BUDGET_PROGRAM.toBase58()]: "Compute Budget",
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
  [EXT_KAMINO_PROXY.toBase58()]: "GLAM ext_kamino",
  [STAGING_EXT_KAMINO_PROXY.toBase58()]: "GLAM ext_kamino (staging)",
  [GLAM_PROGRAM_ID.toBase58()]: "GLAM Protocol",
  [GLAM_STAGING_PROGRAM_ID.toBase58()]: "GLAM Protocol (staging)",
};

function programName(id: PublicKey): string {
  return PROGRAM_NAMES[id.toBase58()] || id.toBase58().slice(0, 12) + "...";
}

/**
 * Convert @solana/kit Instruction to @solana/web3.js TransactionInstruction.
 * AccountRole bit layout: bit 1 = isSigner, bit 0 = isWritable.
 */
function kitIxToWeb3Ix(kitIx: KitInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(kitIx.programAddress),
    keys: ((kitIx as any).accounts || []).map((a: any) => ({
      pubkey: new PublicKey(a.address),
      isSigner: (a.role & 2) !== 0,
      isWritable: (a.role & 1) !== 0,
    })),
    data: Buffer.from((kitIx as any).data || []),
  });
}

/**
 * Collect labeled instructions from a KaminoAction, preserving order.
 * Converts each @solana/kit Instruction to web3.js TransactionInstruction.
 */
function collectKaminoIxs(action: KaminoAction): {
  ix: TransactionInstruction;
  label: string;
}[] {
  const result: { ix: TransactionInstruction; label: string }[] = [];

  const groups: {
    ixs: any[];
    labels: string[];
    prefix: string;
  }[] = [
    {
      ixs: (action as any).computeBudgetIxs || [],
      labels: [],
      prefix: "computeBudget",
    },
    {
      ixs: action.setupIxs || [],
      labels: (action as any).setupIxsLabels || [],
      prefix: "setup",
    },
    {
      ixs: (action as any).inBetweenIxs || [],
      labels: (action as any).inBetweenIxsLabels || [],
      prefix: "between",
    },
    {
      ixs: action.lendingIxs || [],
      labels: (action as any).lendingIxsLabels || [],
      prefix: "lending",
    },
    {
      ixs: action.cleanupIxs || [],
      labels: (action as any).cleanupIxsLabels || [],
      prefix: "cleanup",
    },
  ];

  for (const { ixs, labels, prefix } of groups) {
    for (let i = 0; i < ixs.length; i++) {
      result.push({
        ix: kitIxToWeb3Ix(ixs[i]),
        label: labels[i] || `${prefix}[${i}]`,
      });
    }
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── Step 1: Setup ──────────────────────────────────────────────────────────

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  const glamStateStr = process.env.GLAM_STATE;
  const depositAmount = process.env.DEPOSIT_AMOUNT || "1000000"; // 1 USDC

  if (!rpcUrl || !walletPath || !glamStateStr) {
    console.error(
      "Missing environment variables. Copy .env.example to .env and fill in values.",
    );
    console.error("Required: ANCHOR_PROVIDER_URL, ANCHOR_WALLET, GLAM_STATE");
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const rpc = createSolanaRpc(rpcUrl as any);
  const signer = loadKeypair(walletPath);
  const glamState = new PublicKey(glamStateStr);
  const glamVault = getVaultPda(glamState);

  console.log(
    "===============================================================",
  );
  console.log(
    `  ix-mapper Demo: Kamino USDC Deposit via GLAM Vault (${STAGING ? "staging" : "production"})`,
  );
  console.log(
    "===============================================================",
  );
  console.log();
  console.log(`  Signer:       ${signer.publicKey.toBase58()}`);
  console.log(`  GLAM State:   ${glamState.toBase58()}`);
  console.log(`  GLAM Vault:   ${glamVault.toBase58()}`);
  console.log(`  Deposit:      ${Number(depositAmount) / 1e6} USDC`);
  console.log();

  // ── Step 2: Load Kamino Market & Build Raw Deposit Instructions ────────────

  console.log("[Step 2] Loading Kamino market...");
  const market = await KaminoMarket.load(
    rpc as any,
    KAMINO_MAIN_MARKET as Address,
    400,
  );
  if (!market) {
    throw new Error("Failed to load Kamino market");
  }

  // Create a TransactionSigner wrapper for the vault PDA.
  // The klend-sdk only uses the `address` field to derive accounts.
  const vaultSigner = {
    address: glamVault.toBase58() as Address,
    signTransactions: async (txs: any[]) => txs,
  } as TransactionSigner;

  console.log("[Step 2] Building raw deposit instructions (vault as owner)...");
  const depositAction = await KaminoAction.buildDepositTxns(
    market,
    depositAmount,
    USDC_MINT as Address,
    vaultSigner, // vault PDA acts as "owner" in raw Kamino instructions
    new VanillaObligation(
      "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD" as Address,
    ),
    true, // useV2Ixs — generate v2 instructions that match ix-mapper mapping config
    undefined, // scopeRefreshConfig
  );

  let rawIxs = collectKaminoIxs(depositAction);
  console.log(`[Step 2] Kamino SDK generated ${rawIxs.length} instructions`);

  console.log();

  // ── Step 3: Map Each Instruction Through ix-mapper ─────────────────────────

  console.log(
    "---------------------------------------------------------------",
  );
  console.log("  Instruction Mapping Report");
  console.log(
    "---------------------------------------------------------------",
  );

  const finalIxs: TransactionInstruction[] = [];
  let mappedCount = 0;
  let keptCount = 0;

  for (let i = 0; i < rawIxs.length; i++) {
    const { ix, label } = rawIxs[i];
    const srcProgram = programName(ix.programId);

    const mapped = mapToGlamIx(ix, glamState, signer.publicKey, STAGING);

    if (mapped) {
      // Successfully mapped to GLAM proxy instruction.
      // The vault PDA can't sign at the transaction level — wherever the klend-sdk
      // set the vault as a signer (e.g. fee_payer), replace with the actual signer.
      const fixedMapped = fixSignerAccounts(
        mapped,
        glamState,
        signer.publicKey,
        STAGING,
      );
      finalIxs.push(fixedMapped);
      mappedCount++;
      const signerFixed = fixedMapped.keys.some(
        (k: any, j: number) => !k.pubkey.equals(mapped.keys[j].pubkey),
      );
      console.log(`  [${i + 1}] ${label}`);
      console.log(
        `      ${srcProgram}  -->  ${programName(mapped.programId)}${signerFixed ? "  (fee_payer: vault -> signer)" : ""}`,
      );
      console.log(
        `      Accounts: ${ix.keys.length} -> ${mapped.keys.length}  |  MAPPED`,
      );
      // Show key accounts in the mapped instruction
      console.log(`      Mapped instruction accounts:`);
      console.log(
        `        [0] glam_state:    ${fixedMapped.keys[0].pubkey.toBase58()}  W=${fixedMapped.keys[0].isWritable} S=${fixedMapped.keys[0].isSigner}`,
      );
      console.log(
        `        [1] glam_vault:    ${fixedMapped.keys[1].pubkey.toBase58()}  W=${fixedMapped.keys[1].isWritable} S=${fixedMapped.keys[1].isSigner}`,
      );
      console.log(
        `        [2] glam_signer:   ${fixedMapped.keys[2].pubkey.toBase58()}  W=${fixedMapped.keys[2].isWritable} S=${fixedMapped.keys[2].isSigner}`,
      );
      console.log(
        `        [3] integ_auth:    ${fixedMapped.keys[3].pubkey.toBase58()}  W=${fixedMapped.keys[3].isWritable} S=${fixedMapped.keys[3].isSigner}`,
      );
      console.log(
        `        [4] klend_program: ${fixedMapped.keys[4].pubkey.toBase58()}`,
      );
      console.log(
        `        [5] glam_program:  ${fixedMapped.keys[5].pubkey.toBase58()}`,
      );
      console.log(
        `      Discriminator (dst): [${Array.from(mapped.data.subarray(0, 8)).join(", ")}]`,
      );
    } else {
      // Not mapped — fix vault PDA signer to wallet where needed (e.g. ATA payer)
      const fixed = fixSignerAccounts(ix, glamState, signer.publicKey, STAGING);
      finalIxs.push(fixed);
      keptCount++;
      console.log(`  [${i + 1}] ${label}`);
      console.log(`      ${srcProgram}  (kept as-is)`);
      console.log(`      Accounts: ${ix.keys.length}  |  KEPT`);
    }
    console.log();
  }

  console.log(
    "---------------------------------------------------------------",
  );
  console.log(`  Summary: ${mappedCount} mapped | ${keptCount} kept as-is`);
  console.log(`  Total instructions: ${finalIxs.length}`);
  console.log(
    "---------------------------------------------------------------",
  );
  console.log();

  // ── Step 4: Build Versioned Transaction & Simulate ─────────────────────────

  console.log("[Step 4] Building versioned transaction...");
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: finalIxs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([signer]);

  console.log("[Step 4] Simulating transaction on mainnet...\n");
  const simulation = await connection.simulateTransaction(tx, {
    sigVerify: true,
  });

  // ── Step 5: Print Results ──────────────────────────────────────────────────

  console.log(
    "===============================================================",
  );
  console.log("  Simulation Result");
  console.log(
    "===============================================================",
  );

  if (simulation.value.err) {
    console.log("  Status:  FAILED (expected if vault has no USDC balance)");
    console.log(`  Error:   ${JSON.stringify(simulation.value.err)}`);
  } else {
    console.log("  Status:  SUCCESS");
  }
  console.log(`  CU Used: ${simulation.value.unitsConsumed}`);

  // Print ALL simulation logs for evidence
  if (simulation.value.logs && simulation.value.logs.length > 0) {
    console.log();
    console.log(
      "---------------------------------------------------------------",
    );
    console.log("  Full Simulation Logs");
    console.log(
      "---------------------------------------------------------------",
    );
    for (const log of simulation.value.logs) {
      console.log(`  ${log}`);
    }
    console.log(
      "---------------------------------------------------------------",
    );
  }

  console.log();
  console.log(
    `Kamino instructions mapped to ext_kamino proxy: ${getExtKaminoProxy().toBase58()}`,
  );
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
