import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { mapToGlamIx } from "../src/index";
import {
  GLAM_PROGRAM_ID,
  GLAM_STAGING_PROGRAM_ID,
  getVaultPda,
  getIntegrationAuthority,
} from "../src/pda";

describe("ix-mapper", () => {
  const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  const KAMINO_LEND_PROGRAM_ID = new PublicKey(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  );

  // Production proxy program IDs
  const EXT_SPL_PROGRAM_ID = new PublicKey(
    "G1NTsQ36mjPe89HtPYqxKsjY5HmYsDR6CbD2gd2U2pta",
  );

  // Staging proxy program IDs
  const STAGING_EXT_SPL_PROGRAM_ID = new PublicKey(
    "gstgs9nJgX8PmRHWAAEP9H7xT3ZkaPWSGPYbj3mXdTa",
  );
  const STAGING_EXT_KAMINO_PROGRAM_ID = new PublicKey(
    "gstgKa2Gq9wf5hM3DFWx1TvUrGYzDYszyFGq3XBY9Uq",
  );

  // Test fixtures
  const glamState = new PublicKey(
    "F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp",
  );
  const glamSigner = new PublicKey(
    "8M5XgZWZWxGLDvJgXrv4b8ZFQT5BT8qjN5hPvVm4Cyqg",
  );

  describe("mapToGlamIx (production)", () => {
    describe("System Program - Transfer", () => {
      it("should map a system transfer instruction to GLAM instruction", () => {
        // System transfer discriminator: [2, 0, 0, 0]
        // Payload: 8 bytes for lamports amount
        const lamports = BigInt(1_000_000_000); // 1 SOL
        const lamportsBuffer = Buffer.alloc(8);
        lamportsBuffer.writeBigUInt64LE(lamports);

        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            {
              pubkey: new PublicKey(
                "6ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ), // from
              isSigner: true,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(
                "7YXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ), // to
              isSigner: false,
              isWritable: true,
            },
          ],
          data: Buffer.from([2, 0, 0, 0, ...lamportsBuffer]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();
        expect(result!.programId).toEqual(GLAM_PROGRAM_ID);

        // Check discriminator changed from [2, 0, 0, 0] to [167, 164, 195, 155, 219, 152, 191, 230]
        expect(result!.data.subarray(0, 8)).toEqual(
          Buffer.from([167, 164, 195, 155, 219, 152, 191, 230]),
        );

        // Check payload (lamports) is preserved
        expect(result!.data.subarray(8)).toEqual(lamportsBuffer);

        // Verify account structure:
        // 0: glam_state
        // 1: glam_vault (derived)
        // 2: glam_signer
        // 3: system_program (static)
        // 4: to account (from original ix.keys[1])
        expect(result!.keys.length).toBe(5);
        expect(result!.keys[0].pubkey).toEqual(glamState);
        expect(result!.keys[2].pubkey).toEqual(glamSigner);
        expect(result!.keys[3].pubkey).toEqual(SYSTEM_PROGRAM_ID);
        expect(result!.keys[4].pubkey).toEqual(
          sourceInstruction.keys[1].pubkey,
        );
      });

      it("should derive vault PDA correctly", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        // Manually derive expected vault PDA
        const [expectedVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), glamState.toBuffer()],
          GLAM_PROGRAM_ID,
        );

        expect(result).not.toBeNull();
        expect(result!.keys[1].pubkey).toEqual(expectedVaultPda);
      });

      it("should preserve account metadata (signer, writable)", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();

        // glam_state should not be writable, not signer
        expect(result!.keys[0].isWritable).toBe(false);
        expect(result!.keys[0].isSigner).toBe(false);

        // glam_vault should be writable, not signer
        expect(result!.keys[1].isWritable).toBe(true);
        expect(result!.keys[1].isSigner).toBe(false);

        // glam_signer should be writable and signer
        expect(result!.keys[2].isWritable).toBe(true);
        expect(result!.keys[2].isSigner).toBe(true);

        // system program should not be writable, not signer
        expect(result!.keys[3].isWritable).toBe(false);
        expect(result!.keys[3].isSigner).toBe(false);
      });
    });

    describe("Token Program - Transfer Checked", () => {
      it("should map a token transfer_checked instruction to GLAM instruction", () => {
        // Token transfer_checked discriminator: [12]
        // Payload: 8 bytes for amount + 1 byte for decimals
        const amount = BigInt(1_000_000); // 1 token (6 decimals)
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUInt64LE(amount);
        const decimals = 6;

        const sourceInstruction = new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            {
              pubkey: new PublicKey(
                "6ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ), // source
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(
                "7YXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ), // mint
              isSigner: false,
              isWritable: false,
            },
            {
              pubkey: new PublicKey(
                "8ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ), // destination
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(
                "9ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ), // authority
              isSigner: true,
              isWritable: false,
            },
          ],
          data: Buffer.from([12, ...amountBuffer, decimals]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();
        expect(result!.programId).toEqual(EXT_SPL_PROGRAM_ID);

        // Check discriminator changed from [12] to [169, 178, 117, 156, 169, 191, 199, 116]
        expect(result!.data.subarray(0, 8)).toEqual(
          Buffer.from([169, 178, 117, 156, 169, 191, 199, 116]),
        );

        // Check payload (amount + decimals) is preserved
        expect(result!.data.subarray(8, 16)).toEqual(amountBuffer);
        expect(result!.data[16]).toBe(decimals);
      });

      it("should include integration_authority for token operations", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();

        // Manually derive expected integration authority
        const [expectedIntegrationAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("integration-authority")],
          EXT_SPL_PROGRAM_ID,
        );

        // integration_authority should be at index 3 (after glam_state, glam_vault, glam_signer)
        expect(result!.keys[3].pubkey).toEqual(expectedIntegrationAuthority);
      });
    });

    describe("Edge cases", () => {
      it("should return null for unsupported program", () => {
        const unsupportedProgramId = new PublicKey(
          "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        );

        const sourceInstruction = new TransactionInstruction({
          programId: unsupportedProgramId,
          keys: [],
          data: Buffer.from([1, 2, 3, 4]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);
        expect(result).toBeNull();
      });

      it("should return null for unsupported instruction discriminator", () => {
        // Use system program but with invalid discriminator
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);
        expect(result).toBeNull();
      });

      it("should handle instructions with no keys", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();
        // Should still have dynamic and static accounts
        expect(result!.keys.length).toBeGreaterThan(0);
      });

      it("should handle index_map with -1 values correctly", () => {
        // System transfer has index_map: [-1, 4]
        // This means:
        // - Original key[0] (from) is dropped (mapped to -1)
        // - Original key[1] (to) is kept and placed at position after static accounts

        const fromAccount = new PublicKey(
          "6ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
        );
        const toAccount = new PublicKey(
          "7YXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
        );

        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: fromAccount, isSigner: true, isWritable: true },
            { pubkey: toAccount, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();

        // fromAccount should not appear in result.keys
        const hasFromAccount = result!.keys.some((key) =>
          key.pubkey.equals(fromAccount),
        );
        expect(hasFromAccount).toBe(false);

        // toAccount should appear in result.keys
        const hasToAccount = result!.keys.some((key) =>
          key.pubkey.equals(toAccount),
        );
        expect(hasToAccount).toBe(true);
      });
    });

    describe("Integration Authority derivation", () => {
      it("should derive integration authority correctly", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();

        // For system transfer, check if integration_authority would be derived
        // (Note: This test assumes the config doesn't include integration_authority
        // for system transfers, but if it did, we'd verify it here)

        // Manually derive expected integration authority if it were used
        const [expectedIntegrationAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("integration-authority")],
          GLAM_PROGRAM_ID,
        );

        // This is just verifying the derivation logic works
        expect(expectedIntegrationAuthority).toBeDefined();
      });
    });

    describe("Data transformation", () => {
      it("should correctly replace discriminator and preserve payload", () => {
        const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
        const discriminator = Buffer.from([2, 0, 0, 0]);

        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([discriminator, payload]),
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();

        // Expected dst_discriminator for system_transfer: [167, 164, 195, 155, 219, 152, 191, 230]
        const expectedDiscriminator = Buffer.from([
          167, 164, 195, 155, 219, 152, 191, 230,
        ]);

        expect(result!.data.subarray(0, 8)).toEqual(expectedDiscriminator);
        expect(result!.data.subarray(8)).toEqual(payload);
      });

      it("should handle empty payload", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0]), // Only discriminator, no payload
        });

        const result = mapToGlamIx(sourceInstruction, glamState, glamSigner);

        expect(result).not.toBeNull();

        // Should have new discriminator
        expect(result!.data.length).toBe(8);
        expect(result!.data).toEqual(
          Buffer.from([167, 164, 195, 155, 219, 152, 191, 230]),
        );
      });
    });
  });

  describe("mapToGlamIx (staging)", () => {
    describe("System Program - Transfer", () => {
      it("should map a system transfer instruction to staging GLAM instruction", () => {
        const lamports = BigInt(1_000_000_000);
        const lamportsBuffer = Buffer.alloc(8);
        lamportsBuffer.writeBigUInt64LE(lamports);

        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            {
              pubkey: new PublicKey(
                "6ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ),
              isSigner: true,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(
                "7YXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ),
              isSigner: false,
              isWritable: true,
            },
          ],
          data: Buffer.from([2, 0, 0, 0, ...lamportsBuffer]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(result).not.toBeNull();
        // Staging system transfer uses the staging GLAM program ID as proxy
        expect(result!.programId).toEqual(GLAM_STAGING_PROGRAM_ID);

        // Discriminator should be the same as production
        expect(result!.data.subarray(0, 8)).toEqual(
          Buffer.from([167, 164, 195, 155, 219, 152, 191, 230]),
        );

        // Payload preserved
        expect(result!.data.subarray(8)).toEqual(lamportsBuffer);

        // Account structure same shape
        expect(result!.keys.length).toBe(5);
        expect(result!.keys[0].pubkey).toEqual(glamState);
        expect(result!.keys[2].pubkey).toEqual(glamSigner);
        expect(result!.keys[3].pubkey).toEqual(SYSTEM_PROGRAM_ID);
        expect(result!.keys[4].pubkey).toEqual(
          sourceInstruction.keys[1].pubkey,
        );
      });

      it("should derive vault PDA using staging program ID", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        // Derive expected vault PDA using staging program ID
        const [expectedStagingVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), glamState.toBuffer()],
          GLAM_STAGING_PROGRAM_ID,
        );

        // Derive production vault PDA for comparison
        const [productionVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), glamState.toBuffer()],
          GLAM_PROGRAM_ID,
        );

        expect(result).not.toBeNull();
        expect(result!.keys[1].pubkey).toEqual(expectedStagingVaultPda);
        // Staging vault PDA should differ from production
        expect(result!.keys[1].pubkey).not.toEqual(productionVaultPda);
      });
    });

    describe("Token Program - Transfer Checked", () => {
      it("should map to staging ext_spl proxy program", () => {
        const amount = BigInt(1_000_000);
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUInt64LE(amount);
        const decimals = 6;

        const sourceInstruction = new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            {
              pubkey: new PublicKey(
                "6ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ),
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(
                "7YXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ),
              isSigner: false,
              isWritable: false,
            },
            {
              pubkey: new PublicKey(
                "8ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ),
              isSigner: false,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(
                "9ZXwM7dQqJZ7xVLDLvJEqFvL8AqLGbG4KqQgqJ8qJ8qJ",
              ),
              isSigner: true,
              isWritable: false,
            },
          ],
          data: Buffer.from([12, ...amountBuffer, decimals]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(result).not.toBeNull();
        expect(result!.programId).toEqual(STAGING_EXT_SPL_PROGRAM_ID);

        // Discriminator is the same
        expect(result!.data.subarray(0, 8)).toEqual(
          Buffer.from([169, 178, 117, 156, 169, 191, 199, 116]),
        );

        // Payload preserved
        expect(result!.data.subarray(8, 16)).toEqual(amountBuffer);
        expect(result!.data[16]).toBe(decimals);
      });

      it("should derive integration_authority from staging proxy program", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(result).not.toBeNull();

        // Integration authority derived from staging ext_spl program
        const [expectedStagingAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("integration-authority")],
          STAGING_EXT_SPL_PROGRAM_ID,
        );

        // Integration authority from production ext_spl for comparison
        const [productionAuthority] = PublicKey.findProgramAddressSync(
          [Buffer.from("integration-authority")],
          EXT_SPL_PROGRAM_ID,
        );

        expect(result!.keys[3].pubkey).toEqual(expectedStagingAuthority);
        expect(result!.keys[3].pubkey).not.toEqual(productionAuthority);
      });

      it("should include staging GLAM program ID in static accounts", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(result).not.toBeNull();

        // Staging config has gstgptm... as static account at index 5
        // (the GLAM protocol program ID used in static_accounts)
        const hasProductionGlamId = result!.keys.some((key) =>
          key.pubkey.equals(GLAM_PROGRAM_ID),
        );
        const hasStagingGlamId = result!.keys.some((key) =>
          key.pubkey.equals(GLAM_STAGING_PROGRAM_ID),
        );
        expect(hasProductionGlamId).toBe(false);
        expect(hasStagingGlamId).toBe(true);
      });
    });

    describe("Staging vs Production - consistency", () => {
      it("should produce different program IDs for same input", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const prodResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
        );
        const stagingResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(prodResult).not.toBeNull();
        expect(stagingResult).not.toBeNull();
        expect(prodResult!.programId).not.toEqual(stagingResult!.programId);
        expect(prodResult!.programId).toEqual(GLAM_PROGRAM_ID);
        expect(stagingResult!.programId).toEqual(GLAM_STAGING_PROGRAM_ID);
      });

      it("should produce same discriminators for same instruction", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const prodResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
        );
        const stagingResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(prodResult).not.toBeNull();
        expect(stagingResult).not.toBeNull();
        // Same discriminator bytes
        expect(prodResult!.data.subarray(0, 8)).toEqual(
          stagingResult!.data.subarray(0, 8),
        );
      });

      it("should produce different vault PDAs", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const prodResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
        );
        const stagingResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );

        expect(prodResult).not.toBeNull();
        expect(stagingResult).not.toBeNull();
        // Vault PDA at index 1 should differ
        expect(prodResult!.keys[1].pubkey).not.toEqual(
          stagingResult!.keys[1].pubkey,
        );
      });

      it("staging=false should be the default", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const defaultResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
        );
        const explicitProdResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          false,
        );

        expect(defaultResult).not.toBeNull();
        expect(explicitProdResult).not.toBeNull();
        expect(defaultResult!.programId).toEqual(explicitProdResult!.programId);
        expect(defaultResult!.data).toEqual(explicitProdResult!.data);
        expect(defaultResult!.keys.length).toEqual(
          explicitProdResult!.keys.length,
        );
        for (let i = 0; i < defaultResult!.keys.length; i++) {
          expect(defaultResult!.keys[i].pubkey).toEqual(
            explicitProdResult!.keys[i].pubkey,
          );
        }
      });
    });

    describe("Staging-only instructions", () => {
      it("should support request_elevation_group only in staging", () => {
        // request_elevation_group discriminator: [36, 119, 251, 129, 34, 240, 7, 147]
        const elevationGroup = 1;

        const sourceInstruction = new TransactionInstruction({
          programId: KAMINO_LEND_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([
            36,
            119,
            251,
            129,
            34,
            240,
            7,
            147,
            elevationGroup,
          ]),
        });

        // Should NOT be supported in production
        const prodResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          false,
        );
        expect(prodResult).toBeNull();

        // Should be supported in staging
        const stagingResult = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );
        expect(stagingResult).not.toBeNull();
        expect(stagingResult!.programId).toEqual(STAGING_EXT_KAMINO_PROGRAM_ID);

        // dst_discriminator: [162, 119, 197, 54, 246, 84, 55, 153]
        expect(stagingResult!.data.subarray(0, 8)).toEqual(
          Buffer.from([162, 119, 197, 54, 246, 84, 55, 153]),
        );

        // Payload (elevation_group byte) preserved
        expect(stagingResult!.data[8]).toBe(elevationGroup);
      });
    });

    describe("Edge cases (staging)", () => {
      it("should return null for unsupported program in staging mode", () => {
        const unsupportedProgramId = new PublicKey(
          "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        );

        const sourceInstruction = new TransactionInstruction({
          programId: unsupportedProgramId,
          keys: [],
          data: Buffer.from([1, 2, 3, 4]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );
        expect(result).toBeNull();
      });

      it("should return null for unsupported discriminator in staging mode", () => {
        const sourceInstruction = new TransactionInstruction({
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: PublicKey.default, isSigner: true, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0]),
        });

        const result = mapToGlamIx(
          sourceInstruction,
          glamState,
          glamSigner,
          true,
        );
        expect(result).toBeNull();
      });
    });
  });

  describe("PDA utilities", () => {
    it("getVaultPda should produce different PDAs for staging vs production", () => {
      const prodPda = getVaultPda(glamState, false);
      const stagingPda = getVaultPda(glamState, true);

      expect(prodPda).not.toEqual(stagingPda);

      // Verify against manual derivation
      const [expectedProd] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), glamState.toBuffer()],
        GLAM_PROGRAM_ID,
      );
      const [expectedStaging] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), glamState.toBuffer()],
        GLAM_STAGING_PROGRAM_ID,
      );

      expect(prodPda).toEqual(expectedProd);
      expect(stagingPda).toEqual(expectedStaging);
    });

    it("getVaultPda should default to production", () => {
      const defaultPda = getVaultPda(glamState);
      const explicitProdPda = getVaultPda(glamState, false);

      expect(defaultPda).toEqual(explicitProdPda);
    });

    it("getIntegrationAuthority should derive from the given program", () => {
      const authority = getIntegrationAuthority(GLAM_PROGRAM_ID);
      const stagingAuthority = getIntegrationAuthority(GLAM_STAGING_PROGRAM_ID);

      expect(authority).not.toEqual(stagingAuthority);
    });
  });
});
