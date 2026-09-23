import { describe } from "./mapper.js";
import type {
  MappingContext,
  Mapper,
  MapResult,
  NeutralAccount,
  NeutralInstruction,
} from "./mapper.js";

/**
 * The Solana Kit instruction shape, structurally: an address string, account metas with a
 * role and, for a signing account, the `signer` object Kit's signer-aware flow reads, and
 * bytes. Nothing from `@solana/kit` is imported, so a Kit instruction of any version fits.
 * Kit brands its addresses at the type level, so building a Kit instruction takes the
 * caller's `address` function to brand the result, exactly as web3.js building takes the
 * library's constructors.
 */
export interface KitAccountMetaLike {
  readonly address: string;
  /** `AccountRole`: bit 0 writable, bit 1 signer. */
  readonly role: number;
  /** A `TransactionSigner`, when the caller's meta carries one. */
  readonly signer?: unknown;
}

export interface KitInstructionLike {
  readonly programAddress: string;
  readonly accounts?: readonly KitAccountMetaLike[];
  /** Kit's bytes are read-only; any array-like of bytes is copied. */
  readonly data?: ArrayLike<number>;
}

/** The four account roles, as Kit numbers them: bit 0 writable, bit 1 signer. */
export type KitRole = 0 | 1 | 2 | 3;

/** The signer a meta carries, `never` for one that carries none; distributes over a union. */
type KitSignerOfMeta<Meta> = Meta extends { readonly signer: infer Signer }
  ? Signer
  : never;

/**
 * The signer type the caller's instruction carries, when its metas carry one: Kit's
 * `TransactionSigner` for an `InstructionWithSigners`, `never` for a plain `Instruction`.
 * Distributes over a union of instruction types, so a member that declares no `accounts`
 * contributes `never` rather than voiding the whole, and reads the signer off the element
 * type of `accounts` rather than inferring it from the instruction as a whole: an
 * intersection of instruction types, Kit's own `Instruction & InstructionWithSigners`,
 * infers no single element type and collapsed to `never`.
 */
export type KitSignerOf<Instruction extends KitInstructionLike> =
  Instruction extends KitInstructionLike
    ? KitSignerOfMeta<NonNullable<Instruction["accounts"]>[number]>
    : never;

/** The two signing roles, the only ones a meta may carry a signer under. */
export type KitSigningRole = 2 | 3;

/**
 * A mapped account meta: a signer object rides only on a signing role, so a mapped
 * instruction is a Kit `Instruction` and, when the caller's metas carried signers, an
 * `InstructionWithSigners`.
 */
export type KitMappedAccount<Address extends string, Signer> =
  | {
      readonly address: Address;
      readonly role: KitRole;
      readonly signer?: never;
    }
  | {
      readonly address: Address;
      readonly role: KitSigningRole;
      readonly signer: Signer;
    };

export interface KitInstruction<
  Address extends string = string,
  Signer = never,
> {
  readonly programAddress: Address;
  readonly accounts: readonly KitMappedAccount<Address, Signer>[];
  readonly data: Uint8Array;
}

const WRITABLE_BIT = 1;
const SIGNER_BIT = 2;

export function roleOf(account: NeutralAccount): KitRole {
  return ((account.writable ? WRITABLE_BIT : 0) |
    (account.signer ? SIGNER_BIT : 0)) as KitRole;
}

export function fromKitInstruction(
  instruction: KitInstructionLike,
): NeutralInstruction {
  return {
    programAddress: instruction.programAddress,
    accounts: (instruction.accounts ?? []).map((account) => ({
      address: account.address,
      writable: (account.role & WRITABLE_BIT) !== 0,
      signer: (account.role & SIGNER_BIT) !== 0,
    })),
    data:
      instruction.data === undefined
        ? new Uint8Array(0)
        : Uint8Array.from(instruction.data),
  };
}

/**
 * Builds a Kit instruction; `brand` is Kit's `address`, or the identity for plain strings.
 * A signing account keeps the `signer` object the caller's meta of that address carried,
 * so Kit's signer-aware flow still finds it; a GLAM account the context named has none,
 * and the fee-payer signer covers the `glam_signer` seat.
 */
export function toKitInstruction<Address extends string, Signer = never>(
  instruction: NeutralInstruction,
  brand: (address: string) => Address,
  signers: ReadonlyMap<string, Signer> = new Map(),
): KitInstruction<Address, Signer> {
  return {
    programAddress: brand(instruction.programAddress),
    accounts: instruction.accounts.map(
      (account): KitMappedAccount<Address, Signer> => {
        const address = brand(account.address);
        if (!account.signer) return { address, role: roleOf(account) };
        const signer = signers.get(account.address);
        // the signer bit is set, so the role is one of the two signing roles
        const role = roleOf(account) as KitSigningRole;
        return signer === undefined
          ? { address, role }
          : { address, role, signer };
      },
    ),
    data: instruction.data,
  };
}

export type KitMapResult<
  Instruction extends KitInstructionLike,
  Address extends string,
> =
  | (Omit<Extract<MapResult, { kind: "mapped" }>, "instruction"> & {
      readonly instruction: KitInstruction<Address, KitSignerOf<Instruction>>;
    })
  | (Omit<Extract<MapResult, { kind: "passthrough" }>, "instruction"> & {
      readonly instruction: Instruction;
    })
  | Extract<MapResult, { kind: "unsupported" }>;

/**
 * Maps a Kit instruction. A mapped result carries a Kit instruction built with `brand`,
 * its signing accounts keeping the caller's `signer` objects; a passed-through result
 * carries the caller's own instruction object, untouched. An address `brand` refuses comes
 * back as an `unsupported` result with reason `address`, never as a throw.
 */
export function mapKitInstruction<
  Instruction extends KitInstructionLike,
  Address extends string,
>(
  mapper: Mapper,
  instruction: Instruction,
  context: MappingContext,
  brand: (address: string) => Address,
): KitMapResult<Instruction, Address> {
  const result = mapper.map(fromKitInstruction(instruction), context);
  switch (result.kind) {
    case "unsupported":
      return result;
    case "passthrough":
      return { ...result, instruction };
    case "mapped": {
      const signers = new Map<string, KitSignerOf<Instruction>>();
      for (const account of instruction.accounts ?? []) {
        if (account.signer !== undefined) {
          signers.set(
            account.address,
            account.signer as KitSignerOf<Instruction>,
          );
        }
      }
      try {
        return {
          ...result,
          instruction: toKitInstruction<Address, KitSignerOf<Instruction>>(
            result.instruction,
            brand,
            signers,
          ),
        };
      } catch (error) {
        return refusedAddress(result, error);
      }
    }
  }
}

/** The caller's address library refused an address of the mapped instruction. */
export function refusedAddress(
  result: Extract<MapResult, { kind: "mapped" }>,
  error: unknown,
): Extract<MapResult, { kind: "unsupported" }> {
  return {
    kind: "unsupported",
    program: result.program,
    source: result.source,
    reason: "address",
    message: `an address of the mapped instruction was refused: ${
      error instanceof Error ? error.message : describe(error)
    }`,
  };
}
