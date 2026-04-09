import { PublicKey } from "@solana/web3.js";

const GLAM_PROGRAM_ID = new PublicKey(
  "GLAMpaME8wdTEzxtiYEAa5yD8fZbxZiz2hNtV58RZiEz",
);
const GLAM_STAGING_PROGRAM_ID = new PublicKey(
  "gstgptmbgJVi5f8ZmSRVZjZkDQwqKa3xWuUtD5WmJHz",
);

function getGlamProgramId(staging: boolean): PublicKey {
  return staging ? GLAM_STAGING_PROGRAM_ID : GLAM_PROGRAM_ID;
}

function getVaultPda(statePda: PublicKey, staging = false): PublicKey {
  const [pda, _bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), statePda.toBuffer()],
    getGlamProgramId(staging),
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

export {
  GLAM_PROGRAM_ID,
  GLAM_STAGING_PROGRAM_ID,
  getGlamProgramId,
  getVaultPda,
  getIntegrationAuthority,
};
