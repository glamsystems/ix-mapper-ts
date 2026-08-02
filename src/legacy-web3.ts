import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import type {
  NeutralInstruction,
  NeutralInstructionInput,
  NeutralMapperEnvironment,
  SolanaAccountRole,
} from "./core-types";
import {
  isSignerRole,
  isWritableRole,
  normalizeInstructionNeutral,
  roleFromFlags,
} from "./neutral";

interface Web3PublicKeyLike {
  toBase58(): string;
}

interface Web3AccountMetaLike {
  readonly pubkey: Web3PublicKeyLike;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

interface Web3InstructionLike {
  readonly programId: Web3PublicKeyLike;
  readonly keys: readonly Web3AccountMetaLike[];
  readonly data: ArrayLike<number>;
}

interface LegacyKitAccountMeta {
  readonly address: string;
  readonly role: SolanaAccountRole;
}

interface LegacyKitInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly LegacyKitAccountMeta[];
  readonly data?: ArrayLike<number>;
}

type MappableInstruction = Web3InstructionLike | LegacyKitInstruction;

function copyLegacyBytes(data: ArrayLike<number> | undefined): Uint8Array {
  if (
    data === undefined ||
    !Number.isSafeInteger(data.length) ||
    data.length < 0 ||
    data.length > 1232
  ) {
    throw new TypeError("Instruction data must be a bounded byte array");
  }
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError("Instruction data contains a non-byte value");
    }
    bytes[index] = byte;
  }
  return bytes;
}

function normalizeLegacyInstruction(
  instruction: MappableInstruction,
  environment: NeutralMapperEnvironment,
): NeutralInstruction {
  if (typeof instruction !== "object" || instruction === null) {
    throw new TypeError("Instruction must be an object");
  }

  const hasWeb3Program = "programId" in instruction;
  const hasNeutralProgram = "programAddress" in instruction;
  if (hasWeb3Program === hasNeutralProgram) {
    throw new TypeError(
      "Instruction must have exactly one program-address representation",
    );
  }

  let neutral: NeutralInstructionInput;
  if (hasWeb3Program) {
    const web3 = instruction as Web3InstructionLike;
    if (
      typeof web3.programId?.toBase58 !== "function" ||
      !Array.isArray(web3.keys)
    ) {
      throw new TypeError(
        "web3.js instruction has malformed program or accounts",
      );
    }
    neutral = {
      programAddress: web3.programId.toBase58(),
      accounts: web3.keys.map((account, index) => {
        if (
          typeof account?.pubkey?.toBase58 !== "function" ||
          typeof account.isSigner !== "boolean" ||
          typeof account.isWritable !== "boolean"
        ) {
          throw new TypeError(`web3.js account ${index} is malformed`);
        }
        return {
          address: account.pubkey.toBase58(),
          role: roleFromFlags(account.isWritable, account.isSigner),
        };
      }),
      data: copyLegacyBytes(web3.data),
    };
  } else {
    const kit = instruction as LegacyKitInstruction;
    neutral = {
      programAddress: kit.programAddress,
      accounts: kit.accounts,
      data: copyLegacyBytes(kit.data),
    };
  }

  return normalizeInstructionNeutral(neutral, environment);
}

function toWeb3Instruction(
  instruction: NeutralInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: instruction.accounts.map(({ address, role }) => ({
      pubkey: new PublicKey(address),
      isSigner: isSignerRole(role),
      isWritable: isWritableRole(role),
    })),
    data: Buffer.from(instruction.data),
  });
}

export { normalizeLegacyInstruction, toWeb3Instruction };
export type {
  LegacyKitAccountMeta,
  LegacyKitInstruction,
  MappableInstruction,
  Web3AccountMetaLike,
  Web3InstructionLike,
  Web3PublicKeyLike,
};
