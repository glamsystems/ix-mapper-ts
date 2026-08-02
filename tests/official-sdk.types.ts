import { PublicKey } from "@solana/web3.js";
import { deposit } from "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/deposit";

import { mapInstruction, normalizeInstruction } from "../src/index";

declare const officialInstruction: ReturnType<typeof deposit>;
declare const glamState: PublicKey;
declare const glamSigner: PublicKey;

mapInstruction(officialInstruction, glamState, glamSigner);
normalizeInstruction(officialInstruction);
