/**
 * The mapping document: one per source program and environment, listing every instruction
 * of the program with a disposition. The shape is the contract between the generator, this
 * mapper and the Java mapper; `parseMappingDocument` admits a document into it.
 */

export const SCHEMA_VERSION = 1 as const;

export const DYNAMIC_ACCOUNT_NAMES = [
  "glam_state",
  "glam_vault",
  "glam_signer",
  "integration_authority",
] as const;

export type DynamicAccountName = (typeof DYNAMIC_ACCOUNT_NAMES)[number];

/** How an absent optional account reaches the program. */
export type OptionalKind =
  /** A client leaves it out of the account list; only a trailing run may be absent. */
  | "omitted"
  /** A client passes the source program's id in its place. */
  | "program_id";

export interface Provenance {
  readonly generator?: string;
  readonly source_idl?: string;
  readonly proxy_idl?: string;
  readonly config_revision: number;
}

/** One position of the source instruction's account list. */
export interface SourceAccount {
  readonly name: string;
  readonly writable: boolean;
  readonly signer: boolean;
  /** The signer privilege is the caller's choice, not the IDL's. */
  readonly dynamic_signer?: true;
  readonly optional?: OptionalKind;
  /** The account a mapper must find here: a dynamic account name or an address. */
  readonly expect?: string;
}

interface SeatBase {
  readonly index: number;
  readonly writable: boolean;
  readonly signer: boolean;
}

export interface DynamicSeat extends SeatBase {
  readonly kind: "dynamic";
  readonly name: DynamicAccountName;
}

export interface StaticSeat extends SeatBase {
  readonly kind: "static";
  readonly address: string;
}

export interface SourceSeat extends SeatBase {
  readonly kind: "source";
  /** The position of the source account list this seat forwards. */
  readonly source: number;
  /**
   * An optional account of the handler's own: absence reaches it as the proxy program's id,
   * so the source program's id found at the position is rewritten to the proxy program.
   */
  readonly sentinel?: true;
}

/**
 * A declared account of the handler that a native instruction never carries, supplied by
 * the context at its account index (a routing table of the extension's own, keyed by the
 * vault's state). The mapper interprets no role; it hands the role and the resolved
 * derivation to the context's supplier and places what comes back at the account index.
 */
export interface SuppliedDestinationAccount {
  readonly index: number;
  readonly kind: "supplied";
  /** What the account is, in the caller's vocabulary; never blank. */
  readonly role: string;
  /** The handler's declared flag. */
  readonly writable: boolean;
  /** Always false: a supplied account never signs. */
  readonly signer: boolean;
  /** How the account derives, when the handler's IDL states it. */
  readonly derivation?: Derivation;
}

/**
 * How a supplied account derives, as the handler's IDL states it: the program the address
 * is derived under and the seeds, in order.
 */
export interface Derivation {
  readonly program: string;
  readonly seeds: readonly Seed[];
}

/** Constant bytes, at most 32. */
export interface ConstSeed {
  readonly kind: "const";
  readonly value: readonly number[];
}

/** The address the mapper places at an account index of the mapped instruction. */
export interface AccountSeed {
  readonly kind: "account";
  readonly index: number;
}

/** An argument of the instruction data by its path, which only a supplier that reads the data resolves. */
export interface ArgSeed {
  readonly kind: "arg";
  readonly path: string;
}

export type Seed = ConstSeed | AccountSeed | ArgSeed;

/** One seat of the mapped instruction, with the flags the handler declares for it. */
export type DestinationAccount =
  | DynamicSeat
  | StaticSeat
  | SourceSeat
  | SuppliedDestinationAccount;

export interface RemainingAccounts {
  /** `any` forwards accounts beyond the listed positions after the seats; `none` refuses them. */
  readonly kind: "any" | "none";
}

/**
 * One account the caller supplies to a mapped instruction, inserted after the seats and
 * before the accounts beyond the list, read-only and unsigned: a GLAM-side account the
 * handler reads from its remaining accounts that a native instruction never carries (a
 * price oracle, a strategy's market). The mapper interprets no role; it hands the role and
 * the addresses at the `of` positions to the context's supplier and inserts what comes back.
 */
export interface SuppliedAccount {
  /** What the account is, in the caller's vocabulary; never blank. */
  readonly role: string;
  /** Source positions whose addresses the supplier receives with the role. */
  readonly of?: readonly number[];
  /** The supplier may leave it out; optional accounts trail the required ones. */
  readonly optional?: true;
}

export interface Handler {
  readonly name: string;
  readonly discriminator: readonly number[];
}

export interface MappedInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly disposition: "map";
  readonly handler: Handler;
  readonly source_accounts: readonly SourceAccount[];
  readonly destination_accounts: readonly DestinationAccount[];
  readonly remaining_accounts: RemainingAccounts;
  /** What the context supplies after the seats, in order; absent when nothing is. */
  readonly supplied_accounts?: readonly SuppliedAccount[];
}

export interface PassthroughInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly disposition: "passthrough";
  readonly reason: string;
}

export interface UnsupportedInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly disposition: "unsupported";
  readonly reason: string;
}

export type InstructionEntry =
  | MappedInstruction
  | PassthroughInstruction
  | UnsupportedInstruction;

export interface MappingDocument {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly environment: string;
  readonly program_id: string;
  readonly proxy_program_id: string;
  readonly provenance?: Provenance;
  readonly instructions: readonly InstructionEntry[];
}
