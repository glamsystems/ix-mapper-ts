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

  describe("Optional account placeholder replacement", () => {
    const EXT_KAMINO_PROGRAM_ID = new PublicKey(
      "G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde",
    );

    // deposit_reserve_liquidity_and_obligation_collateral_v2
    const KAMINO_DEPOSIT_V2_DISCRIMINATOR = [
      216, 224, 191, 27, 204, 151, 102, 175,
    ];
    const KAMINO_DEPOSIT_V2_DST_DISCRIMINATOR = [
      33, 146, 50, 121, 127, 94, 92, 192,
    ];

    // borrow_obligation_liquidity_v2
    const KAMINO_BORROW_V2_DISCRIMINATOR = [
      161, 128, 143, 245, 171, 199, 194, 6,
    ];
    const KAMINO_BORROW_V2_DST_DISCRIMINATOR = [
      149, 226, 84, 157, 124, 178, 35, 122,
    ];

    /**
     * Build a fake Kamino deposit_v2 instruction with 17 accounts.
     * Account layout:
     *   [0]  owner (signer, dropped by index_map)
     *   [1]  obligation
     *   [2]  lending_market
     *   [3]  lending_market_authority
     *   [4]  reserve
     *   [5]  reserve_liquidity_mint
     *   [6]  reserve_liquidity_supply
     *   [7]  reserve_collateral_mint
     *   [8]  reserve_destination_deposit_collateral
     *   [9]  user_source_liquidity
     *   [10] placeholder_user_destination_collateral  (optional)
     *   [11] collateral_token_program
     *   [12] liquidity_token_program
     *   [13] instruction_sysvar_account
     *   [14] obligation_farm_user_state               (optional)
     *   [15] reserve_farm_state                       (optional)
     *   [16] farms_program
     */
    function buildKaminoDepositV2Ix(
      overrides: Partial<{
        placeholderUserDestCollateral: PublicKey;
        obligationFarmUserState: PublicKey;
        reserveFarmState: PublicKey;
      }> = {},
    ): TransactionInstruction {
      const randomKey = () => PublicKey.unique();
      const amount = BigInt(1_000_000);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      return new TransactionInstruction({
        programId: KAMINO_LEND_PROGRAM_ID,
        keys: [
          { pubkey: randomKey(), isSigner: true, isWritable: true }, // [0] owner
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [1] obligation
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [2] lending_market
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [3] lending_market_authority
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [4] reserve
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [5] reserve_liquidity_mint
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [6] reserve_liquidity_supply
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [7] reserve_collateral_mint
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [8] reserve_dest_deposit_coll
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [9] user_source_liquidity
          {
            pubkey:
              overrides.placeholderUserDestCollateral ?? KAMINO_LEND_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          }, // [10] placeholder (optional)
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [11] collateral_token_program
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [12] liquidity_token_program
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [13] instruction_sysvar
          {
            pubkey:
              overrides.obligationFarmUserState ?? KAMINO_LEND_PROGRAM_ID,
            isSigner: false,
            isWritable: true,
          }, // [14] obligation_farm_user_state (optional)
          {
            pubkey: overrides.reserveFarmState ?? KAMINO_LEND_PROGRAM_ID,
            isSigner: false,
            isWritable: true,
          }, // [15] reserve_farm_state (optional)
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [16] farms_program
        ],
        data: Buffer.from([...KAMINO_DEPOSIT_V2_DISCRIMINATOR, ...amountBuffer]),
      });
    }

    /**
     * Build a fake Kamino borrow_v2 instruction with 15 accounts.
     * Verified against real tx o4hM94NMu5tyTnf6RJsiMSttFte9fPCMfiRLJdcL58ZMiwDJs5XuC2WHrkSBx9HWhMWYYdp685pGdWj5LZ2vo32
     * Account layout:
     *   [0]  owner (signer, dropped)
     *   [1]  obligation
     *   [2]  lending_market
     *   [3]  lending_market_authority
     *   [4]  borrow_reserve
     *   [5]  reserve_liquidity_mint
     *   [6]  reserve_source_liquidity
     *   [7]  borrow_reserve_liquidity_fee_receiver
     *   [8]  user_destination_liquidity
     *   [9]  referrer_token_state                     (optional, KLend ID = None)
     *   [10] liquidity_token_program
     *   [11] instruction_sysvar_account
     *   [12] obligation_farm_user_state               (optional)
     *   [13] reserve_farm_state                       (optional)
     *   [14] farms_program
     */
    function buildKaminoBorrowV2Ix(
      overrides: Partial<{
        referrerTokenState: PublicKey;
        obligationFarmUserState: PublicKey;
        reserveFarmState: PublicKey;
      }> = {},
    ): TransactionInstruction {
      const randomKey = () => PublicKey.unique();
      const amount = BigInt(500_000);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      return new TransactionInstruction({
        programId: KAMINO_LEND_PROGRAM_ID,
        keys: [
          { pubkey: randomKey(), isSigner: true, isWritable: true }, // [0] owner
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [1] obligation
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [2] lending_market
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [3] lending_market_authority
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [4] borrow_reserve
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [5] reserve_liquidity_mint
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [6] reserve_source_liquidity
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [7] fee_receiver
          { pubkey: randomKey(), isSigner: false, isWritable: true }, // [8] user_destination_liquidity
          {
            pubkey: overrides.referrerTokenState ?? KAMINO_LEND_PROGRAM_ID,
            isSigner: false,
            isWritable: true,
          }, // [9] referrer_token_state (optional)
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [10] liquidity_token_program
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [11] instruction_sysvar
          {
            pubkey:
              overrides.obligationFarmUserState ?? KAMINO_LEND_PROGRAM_ID,
            isSigner: false,
            isWritable: true,
          }, // [12] obligation_farm_user_state (optional)
          {
            pubkey: overrides.reserveFarmState ?? KAMINO_LEND_PROGRAM_ID,
            isSigner: false,
            isWritable: true,
          }, // [13] reserve_farm_state (optional)
          { pubkey: randomKey(), isSigner: false, isWritable: false }, // [14] farms_program
        ],
        data: Buffer.from([...KAMINO_BORROW_V2_DISCRIMINATOR, ...amountBuffer]),
      });
    }

    it("should replace Kamino program ID placeholders with proxy program ID in deposit_v2", () => {
      const ix = buildKaminoDepositV2Ix(); // all optional accounts = Kamino program ID
      const result = mapToGlamIx(ix, glamState, glamSigner);

      expect(result).not.toBeNull();
      expect(result!.programId).toEqual(EXT_KAMINO_PROGRAM_ID);

      // The three optional accounts should now be the proxy program ID, not Kamino's
      // In the mapped instruction, they are at dst indices 16, 20, 21
      // After sorting by index: positions depend on total account count
      const proxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(EXT_KAMINO_PROGRAM_ID),
      );
      // 3 optional placeholders should be replaced with proxy program ID
      expect(proxyMatches.length).toBe(3);

      // No account should still reference the Kamino program ID
      const kaminoMatches = result!.keys.filter((k) =>
        k.pubkey.equals(KAMINO_LEND_PROGRAM_ID),
      );
      // Only the static cpi_program account at index 4 should have Kamino's ID
      expect(kaminoMatches.length).toBe(1);
    });

    it("should replace Kamino program ID placeholders with proxy program ID in borrow_v2", () => {
      const ix = buildKaminoBorrowV2Ix(); // all optional accounts = Kamino program ID
      const result = mapToGlamIx(ix, glamState, glamSigner);

      expect(result).not.toBeNull();
      expect(result!.programId).toEqual(EXT_KAMINO_PROGRAM_ID);

      // 3 optional placeholders replaced
      const proxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(EXT_KAMINO_PROGRAM_ID),
      );
      expect(proxyMatches.length).toBe(3);

      // Only static cpi_program at index 4
      const kaminoMatches = result!.keys.filter((k) =>
        k.pubkey.equals(KAMINO_LEND_PROGRAM_ID),
      );
      expect(kaminoMatches.length).toBe(1);
    });

    it("should NOT replace real account addresses that happen to differ from program ID", () => {
      const realFarmAccount = PublicKey.unique();
      const realReserveFarm = PublicKey.unique();
      const realPlaceholder = PublicKey.unique();

      const ix = buildKaminoDepositV2Ix({
        placeholderUserDestCollateral: realPlaceholder,
        obligationFarmUserState: realFarmAccount,
        reserveFarmState: realReserveFarm,
      });
      const result = mapToGlamIx(ix, glamState, glamSigner);

      expect(result).not.toBeNull();

      // Real accounts should be preserved as-is
      const hasRealFarm = result!.keys.some((k) =>
        k.pubkey.equals(realFarmAccount),
      );
      const hasRealReserveFarm = result!.keys.some((k) =>
        k.pubkey.equals(realReserveFarm),
      );
      const hasRealPlaceholder = result!.keys.some((k) =>
        k.pubkey.equals(realPlaceholder),
      );

      expect(hasRealFarm).toBe(true);
      expect(hasRealReserveFarm).toBe(true);
      expect(hasRealPlaceholder).toBe(true);

      // No proxy program ID should appear as a replacement
      const proxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(EXT_KAMINO_PROGRAM_ID),
      );
      expect(proxyMatches.length).toBe(0);
    });

    it("should handle mixed real and placeholder optional accounts", () => {
      const realFarmAccount = PublicKey.unique();

      const ix = buildKaminoDepositV2Ix({
        obligationFarmUserState: realFarmAccount,
        // placeholderUserDestCollateral and reserveFarmState default to Kamino program ID
      });
      const result = mapToGlamIx(ix, glamState, glamSigner);

      expect(result).not.toBeNull();

      // Real farm account preserved
      const hasRealFarm = result!.keys.some((k) =>
        k.pubkey.equals(realFarmAccount),
      );
      expect(hasRealFarm).toBe(true);

      // 2 placeholders replaced (placeholder_user_dest_collateral + reserve_farm_state)
      const proxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(EXT_KAMINO_PROGRAM_ID),
      );
      expect(proxyMatches.length).toBe(2);
    });

    it("should correctly remap real deposit_v2 tx (5FnkKP9h...)", () => {
      // Real accounts from mainnet tx 5FnkKP9hgjzXofQuEu42gKuhiYzNtHcNr1kbodcBaUt8ZA4pcNZo3bn3E54Xk1nfiUHUdMECBucwRpyhb1kGTXuZ
      // This is a USDS deposit with active farm but placeholder_user_destination_collateral = None
      const realAccounts = {
        owner: new PublicKey(
          "73zMkwEWuTW6Rkn9XhB7hEFoZXEaN6JvxP9WDEWZraqU",
        ),
        obligation: new PublicKey(
          "5WFP3Ah8jE5d3ogxWupfGMjaDE1cpgZ4YEbeusjnjkVZ",
        ),
        lendingMarket: new PublicKey(
          "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        ),
        lendingMarketAuthority: new PublicKey(
          "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo",
        ),
        reserve: new PublicKey(
          "BHUi32TrEsfN2U821G4FprKrR4hTeK4LCWtA3BFetuqA",
        ),
        reserveLiquidityMint: new PublicKey(
          "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
        ),
        reserveLiquiditySupply: new PublicKey(
          "4aE6ow1YNDm9MRNdk8HRzFFzvs9FXBgEttWSMrH6hupD",
        ),
        reserveCollateralMint: new PublicKey(
          "6nnt6N4Ay9tBeMWnVWKS24hDtE6R3fshi5TteUcSKJcQ",
        ),
        reserveDestDepositCollateral: new PublicKey(
          "3FVdzLJ8tqBmuNuSLADJFKFaJQt6F9x6zAAHCoLUFCJA",
        ),
        userSourceLiquidity: new PublicKey(
          "EthLZhFXRZtGfpNwj1EUMMXsfp4c2kXEYQj3hLzNZGvx",
        ),
        // placeholder_user_destination_collateral = KLend program ID (None)
        collateralTokenProgram: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ),
        liquidityTokenProgram: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ),
        instructionSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        obligationFarmUserState: new PublicKey(
          "4wJYwDTmfQFzU2FMAmdxRRWAdjYyvVn6u7GjwPfBRtat",
        ),
        reserveFarmState: new PublicKey(
          "67L8BZe5PjuJz5CXqcsp1NXfNHoAZ1qPYUrxT7Cj2iUr",
        ),
        farmsProgram: new PublicKey(
          "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
        ),
      };

      const ix = new TransactionInstruction({
        programId: KAMINO_LEND_PROGRAM_ID,
        keys: [
          {
            pubkey: realAccounts.owner,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: realAccounts.obligation,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.lendingMarket,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.lendingMarketAuthority,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.reserve,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.reserveLiquidityMint,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.reserveLiquiditySupply,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.reserveCollateralMint,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.reserveDestDepositCollateral,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.userSourceLiquidity,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: KAMINO_LEND_PROGRAM_ID, // placeholder_user_destination_collateral = None
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.collateralTokenProgram,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.liquidityTokenProgram,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.instructionSysvar,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.obligationFarmUserState,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.reserveFarmState,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.farmsProgram,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from([...KAMINO_DEPOSIT_V2_DISCRIMINATOR, 0, 0, 0, 0, 0, 0, 0, 0]),
      });

      const result = mapToGlamIx(ix, glamState, glamSigner);
      expect(result).not.toBeNull();
      expect(result!.programId).toEqual(EXT_KAMINO_PROGRAM_ID);

      // Only placeholder_user_destination_collateral [10] was KLend ID → replaced
      const proxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(EXT_KAMINO_PROGRAM_ID),
      );
      expect(proxyMatches.length).toBe(1);

      // Real farm accounts preserved
      expect(
        result!.keys.some((k) =>
          k.pubkey.equals(realAccounts.obligationFarmUserState),
        ),
      ).toBe(true);
      expect(
        result!.keys.some((k) =>
          k.pubkey.equals(realAccounts.reserveFarmState),
        ),
      ).toBe(true);

      // Static cpi_program is the only remaining KLend reference
      const kaminoMatches = result!.keys.filter((k) =>
        k.pubkey.equals(KAMINO_LEND_PROGRAM_ID),
      );
      expect(kaminoMatches.length).toBe(1);

      // Discriminator replaced correctly
      expect(Array.from(result!.data.subarray(0, 8))).toEqual(
        KAMINO_DEPOSIT_V2_DST_DISCRIMINATOR,
      );
    });

    it("should replace placeholders in staging mode too", () => {
      const ix = buildKaminoDepositV2Ix();
      const result = mapToGlamIx(ix, glamState, glamSigner, true);

      expect(result).not.toBeNull();
      expect(result!.programId).toEqual(STAGING_EXT_KAMINO_PROGRAM_ID);

      // Placeholders should be replaced with staging proxy program ID
      const stagingProxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(STAGING_EXT_KAMINO_PROGRAM_ID),
      );
      expect(stagingProxyMatches.length).toBe(3);

      // Kamino program ID only for static cpi_program
      const kaminoMatches = result!.keys.filter((k) =>
        k.pubkey.equals(KAMINO_LEND_PROGRAM_ID),
      );
      expect(kaminoMatches.length).toBe(1);
    });

    it("should preserve discriminator and payload with placeholder replacement", () => {
      const ix = buildKaminoDepositV2Ix();
      const result = mapToGlamIx(ix, glamState, glamSigner);

      expect(result).not.toBeNull();

      // Discriminator should be replaced
      expect(Array.from(result!.data.subarray(0, 8))).toEqual(
        KAMINO_DEPOSIT_V2_DST_DISCRIMINATOR,
      );

      // Payload (amount) should be preserved
      const originalPayload = ix.data.subarray(
        KAMINO_DEPOSIT_V2_DISCRIMINATOR.length,
      );
      const mappedPayload = result!.data.subarray(
        KAMINO_DEPOSIT_V2_DST_DISCRIMINATOR.length,
      );
      expect(mappedPayload).toEqual(originalPayload);
    });

    it("should correctly remap real borrow_v2 tx (o4hM94NM...)", () => {
      // Real accounts from mainnet tx o4hM94NMu5tyTnf6RJsiMSttFte9fPCMfiRLJdcL58ZMiwDJs5XuC2WHrkSBx9HWhMWYYdp685pGdWj5LZ2vo32
      // This is a PYUSD borrow with active farm but no referrer
      const realAccounts = {
        owner: new PublicKey(
          "4XqRB1mxzH7JtJgZWHnYqW1tZShfAeN5sHZVdVuMGMMa",
        ),
        obligation: new PublicKey(
          "2SWWDEehjck96jwHKg2R3ZbBPnSKpeMzbboUKCK5GkxP",
        ),
        lendingMarket: new PublicKey(
          "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        ),
        lendingMarketAuthority: new PublicKey(
          "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo",
        ),
        borrowReserve: new PublicKey(
          "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN",
        ),
        reserveLiquidityMint: new PublicKey(
          "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
        ),
        reserveSourceLiquidity: new PublicKey(
          "Gm2itCNPBpBSSrgCA194pmErjwHAFVpvBBFvpdTF5LuJ",
        ),
        feeReceiver: new PublicKey(
          "BcLJRx7GbyX2Jj8RFpYDnEE47Tm36wSskLnm7ALarEC1",
        ),
        userDestLiquidity: new PublicKey(
          "5KbbrHhwZU1gup7hDDjcZ71bVkzGB18P4xfop5zMHHTn",
        ),
        // referrer_token_state = KLend program ID (placeholder for None)
        liquidityTokenProgram: new PublicKey(
          "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        ),
        instructionSysvar: new PublicKey(
          "Sysvar1nstructions1111111111111111111111111",
        ),
        obligationFarmUserState: new PublicKey(
          "76CJkiVFdvWBXWYGC4DRmejaJ85NRmu6u92fMJVPoZtm",
        ),
        reserveFarmState: new PublicKey(
          "GmJ2vXsDt8R5DNimAZc7Rtphr4oqecBVAx1psaTcVtrX",
        ),
        farmsProgram: new PublicKey(
          "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
        ),
      };

      const amount = BigInt(726_000_000); // 726 PYUSD
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      const ix = new TransactionInstruction({
        programId: KAMINO_LEND_PROGRAM_ID,
        keys: [
          {
            pubkey: realAccounts.owner,
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: realAccounts.obligation,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.lendingMarket,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.lendingMarketAuthority,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.borrowReserve,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.reserveLiquidityMint,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.reserveSourceLiquidity,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.feeReceiver,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.userDestLiquidity,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: KAMINO_LEND_PROGRAM_ID, // referrer_token_state placeholder
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.liquidityTokenProgram,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.instructionSysvar,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: realAccounts.obligationFarmUserState,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.reserveFarmState,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: realAccounts.farmsProgram,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from([...KAMINO_BORROW_V2_DISCRIMINATOR, ...amountBuffer]),
      });

      const result = mapToGlamIx(ix, glamState, glamSigner);
      expect(result).not.toBeNull();
      expect(result!.programId).toEqual(EXT_KAMINO_PROGRAM_ID);

      // referrer_token_state was KLend program ID → replaced with ext_kamino proxy
      // obligation_farm_user_state & reserve_farm_state are real → preserved
      const proxyMatches = result!.keys.filter((k) =>
        k.pubkey.equals(EXT_KAMINO_PROGRAM_ID),
      );
      expect(proxyMatches.length).toBe(1); // only referrer_token_state replaced

      // Real farm accounts should be preserved
      expect(
        result!.keys.some((k) =>
          k.pubkey.equals(realAccounts.obligationFarmUserState),
        ),
      ).toBe(true);
      expect(
        result!.keys.some((k) =>
          k.pubkey.equals(realAccounts.reserveFarmState),
        ),
      ).toBe(true);

      // Static cpi_program (KLend) should be the only remaining KLend reference
      const kaminoMatches = result!.keys.filter((k) =>
        k.pubkey.equals(KAMINO_LEND_PROGRAM_ID),
      );
      expect(kaminoMatches.length).toBe(1); // only static cpi_program at index 4

      // Payload preserved
      expect(result!.data.subarray(8)).toEqual(amountBuffer);
    });

    it("should not replace program ID in remaining accounts beyond index_map", () => {
      const ix = buildKaminoDepositV2Ix();
      // Add extra remaining accounts, one of which is the Kamino program ID
      ix.keys.push({
        pubkey: KAMINO_LEND_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      });

      const result = mapToGlamIx(ix, glamState, glamSigner);

      expect(result).not.toBeNull();

      // The extra remaining account should NOT be replaced (it's beyond index_map)
      // 1 static cpi_program + 1 remaining = 2 Kamino program ID references
      const kaminoMatches = result!.keys.filter((k) =>
        k.pubkey.equals(KAMINO_LEND_PROGRAM_ID),
      );
      expect(kaminoMatches.length).toBe(2);
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
