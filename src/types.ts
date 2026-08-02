import type { TransactionInstruction } from "@solana/web3.js";
import type { SolanaKitAccountMeta } from "./core-types";

export * from "./core-types";

/** Legacy root/compatibility shape; accepts historical ArrayLike byte data. */
export interface SolanaKitInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly SolanaKitAccountMeta[];
  readonly data?: ArrayLike<number>;
}

export interface MappedInstructionResult {
  kind: "mapped";
  instruction: TransactionInstruction;
  sourceInstructionName: string;
  destinationInstructionName: string;
}

export interface SafePassthroughInstructionResult {
  kind: "safePassthrough";
  instruction: TransactionInstruction;
  sourceInstructionName: string;
}

export interface UnsupportedInstructionResult {
  kind: "unsupported";
  reason: import("./core-types").UnsupportedInstructionReason;
  message: string;
}

/** Existing web3.js-valued strict API result retained for compatibility. */
export type MapInstructionResult =
  | MappedInstructionResult
  | SafePassthroughInstructionResult
  | UnsupportedInstructionResult;
