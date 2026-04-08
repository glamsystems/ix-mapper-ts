import { PublicKey } from "@solana/web3.js";

function getVaultPda(statePda: PublicKey): PublicKey {
  const [pda, _bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), statePda.toBuffer()],
    new PublicKey("GLAMpaME8wdTEzxtiYEAa5yD8fZbxZiz2hNtV58RZiEz"),
  );
  return pda;
}

function getIntegrationAuthority(integrationProgram: PublicKey): PublicKey {
  const [pda, _bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("integration-authority")],
    integrationProgram,
  );

  return pda;
}

export { getVaultPda, getIntegrationAuthority };
