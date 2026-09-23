import { refusedAddress } from "./kit.js";
import type {
  MappingContext,
  Mapper,
  MapResult,
  NeutralInstruction,
} from "./mapper.js";

/**
 * The web3.js v1 instruction shape, structurally: `PublicKey`s with `toBase58()`, account
 * metas with `isSigner`/`isWritable`, and bytes. Building one back needs the library's
 * constructors, which the caller hands over, so this package depends on nothing.
 */
export interface Web3PublicKeyLike {
  toBase58(): string;
}

export interface Web3AccountMetaLike {
  readonly pubkey: Web3PublicKeyLike;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface Web3InstructionLike {
  readonly programId: Web3PublicKeyLike;
  readonly keys: readonly Web3AccountMetaLike[];
  readonly data: Uint8Array;
}

/**
 * What building a web3.js instruction takes: the two classes, and how the library wants
 * its bytes (`Buffer.from` for web3.js v1).
 */
export interface Web3Constructors<
  Key extends Web3PublicKeyLike,
  Instruction,
  Data,
> {
  readonly PublicKey: new (address: string) => Key;
  readonly TransactionInstruction: new (fields: {
    readonly programId: Key;
    readonly keys: {
      readonly pubkey: Key;
      readonly isSigner: boolean;
      readonly isWritable: boolean;
    }[];
    readonly data: Data;
  }) => Instruction;
  readonly data: (bytes: Uint8Array) => Data;
}

export function fromWeb3Instruction(
  instruction: Web3InstructionLike,
): NeutralInstruction {
  return {
    programAddress: instruction.programId.toBase58(),
    accounts: instruction.keys.map((meta) => ({
      address: meta.pubkey.toBase58(),
      writable: meta.isWritable,
      signer: meta.isSigner,
    })),
    data: instruction.data,
  };
}

export function toWeb3Instruction<
  Key extends Web3PublicKeyLike,
  Instruction,
  Data,
>(
  instruction: NeutralInstruction,
  web3: Web3Constructors<Key, Instruction, Data>,
): Instruction {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(instruction.programAddress),
    keys: instruction.accounts.map((account) => ({
      pubkey: new web3.PublicKey(account.address),
      isSigner: account.signer,
      isWritable: account.writable,
    })),
    data: web3.data(instruction.data),
  });
}

export type Web3MapResult<Input extends Web3InstructionLike, Built> =
  | (Omit<Extract<MapResult, { kind: "mapped" }>, "instruction"> & {
      readonly instruction: Built;
    })
  | (Omit<Extract<MapResult, { kind: "passthrough" }>, "instruction"> & {
      readonly instruction: Input;
    })
  | Extract<MapResult, { kind: "unsupported" }>;

/**
 * Maps a web3.js instruction. A mapped result carries an instruction built with the
 * constructors; a passed-through result carries the caller's own instruction, untouched.
 * An address `PublicKey` refuses comes back as an `unsupported` result with reason
 * `address`, never as a throw.
 */
export function mapWeb3Instruction<
  Input extends Web3InstructionLike,
  Key extends Web3PublicKeyLike,
  Built,
  Data,
>(
  mapper: Mapper,
  instruction: Input,
  context: MappingContext,
  web3: Web3Constructors<Key, Built, Data>,
): Web3MapResult<Input, Built> {
  const result = mapper.map(fromWeb3Instruction(instruction), context);
  switch (result.kind) {
    case "unsupported":
      return result;
    case "passthrough":
      return { ...result, instruction };
    case "mapped":
      try {
        return {
          ...result,
          instruction: toWeb3Instruction(result.instruction, web3),
        };
      } catch (error) {
        return refusedAddress(result, error);
      }
  }
}
