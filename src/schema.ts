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

/** One seat of the mapped instruction, with the flags the handler declares for it. */
export type DestinationAccount = DynamicSeat | StaticSeat | SourceSeat;

export interface RemainingAccounts {
  /** `any` forwards accounts beyond the listed positions after the seats; `none` refuses them. */
  readonly kind: "any" | "none";
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
