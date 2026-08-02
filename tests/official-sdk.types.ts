import { PublicKey } from "@solana/web3.js";
import { deposit } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/deposit";
import { withdraw } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdraw";

import { createNeutralMapper, type NeutralMappingContext } from "../src/core";
import {
  mapInstruction,
  normalizeInstruction,
  type SolanaKitInstruction as LegacySolanaKitInstruction,
} from "../src/index";

declare const officialDepositInstruction: ReturnType<typeof deposit>;
declare const officialWithdrawInstruction: ReturnType<typeof withdraw>;
declare const glamState: PublicKey;
declare const glamSigner: PublicKey;
declare const neutralContext: NeutralMappingContext;
declare const neutralMapper: ReturnType<typeof createNeutralMapper>;

neutralMapper.mapInstructionNeutral(officialDepositInstruction, neutralContext);
neutralMapper.mapInstructionNeutral(
  officialWithdrawInstruction,
  neutralContext,
);

mapInstruction(officialDepositInstruction, glamState, glamSigner);
normalizeInstruction(officialDepositInstruction);

const legacyArrayLikeInstruction: LegacySolanaKitInstruction = {
  programAddress: "11111111111111111111111111111111",
  data: [1, 2, 3],
};
normalizeInstruction(legacyArrayLikeInstruction);
