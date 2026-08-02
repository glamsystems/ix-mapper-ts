import type { TransactionInstruction } from "@solana/web3.js";

export interface Account {
  /** Account name or identifier */
  name?: string;
  /** Account public key (for static accounts) */
  account?: string;
  /** Index position in the accounts array */
  index: number;
  /** Whether the account is writable */
  writable: boolean;
  /** Whether the account is a signer */
  signer: boolean;
}

export interface DynamicAccount extends Account {
  /** Name is required for dynamic accounts */
  name: string;
}

export interface StaticAccount extends Account {
  /** Account public key is required for static accounts */
  account: string;
}

export interface Instruction {
  /** Source instruction name */
  src_ix_name: string;
  /** Source instruction discriminator bytes */
  src_discriminator: number[];
  /** Destination instruction name */
  dst_ix_name: string;
  /** Destination instruction discriminator bytes */
  dst_discriminator: number[];
  /** Dynamic accounts that are passed through */
  dynamic_accounts: DynamicAccount[];
  /** Static accounts that are added */
  static_accounts: StaticAccount[];
  /** Index mapping for account reordering */
  index_map: number[];
  /**
   * Source account indices that may use the source program ID as an Anchor
   * optional-account placeholder and should be rewritten to the proxy program.
   */
  program_id_placeholder_indices?: number[];
}

export interface RemappingConfig {
  /** Original program ID */
  program_id: string;
  /** Proxy program ID that handles the remapping */
  proxy_program_id: string;
  /** Array of instruction mappings */
  instructions: Instruction[];
}

/**
 * Collection of all remapping configurations indexed by program ID
 */
export type RemappingConfigs = Record<string, RemappingConfig>;

/** Dynamic accounts whose addresses are supplied or derived by the mapper. */
export type StrictDynamicAccountName =
  | "glam_state"
  | "glam_vault"
  | "glam_signer"
  | "integration_authority";

/**
 * Exact source-account constraint used by schema-v2 mappings.
 *
 * At most one of `account`, `one_of_accounts`, `same_as`, and
 * `dynamic_account` may be present. The constraint is checked before any
 * account is copied into a proxy instruction.
 */
export interface StrictAccountConstraint {
  /** Position in the source instruction's fixed account list. */
  index: number;
  /** The source account must have this writable bit exactly. */
  writable: boolean;
  /** The source account must have this signer bit exactly. */
  signer: boolean;
  /** Require one exact public key. */
  account?: string;
  /** Require one public key from this closed allowlist. */
  one_of_accounts?: string[];
  /** Require the same public key as another fixed source account. */
  same_as?: number;
  /** Require one of the GLAM accounts supplied or derived for this mapping. */
  dynamic_account?: StrictDynamicAccountName;
}

/** Signer/writable constraints for one remaining-account segment. */
export interface StrictRemainingAccountMeta {
  writable: boolean;
  signer: boolean;
}

/** The source instruction may not have any remaining accounts. */
export interface StrictNoRemainingAccounts {
  kind: "none";
}

/**
 * Remaining accounts are two equal-length, ordered segments.
 *
 * This models layouts such as `[writable reserves][readonly markets]`
 * without accepting an arbitrary suffix.
 */
export interface StrictPairedRemainingAccounts {
  kind: "paired_segments";
  first: StrictRemainingAccountMeta;
  second: StrictRemainingAccountMeta;
  /** Defaults to zero when omitted. */
  min_per_segment?: number;
  /** Closed upper bound for each segment. */
  max_per_segment: number;
}

export type StrictRemainingAccounts =
  | StrictNoRemainingAccounts
  | StrictPairedRemainingAccounts;

/** Fail-closed source layout attached to a schema-v2 mapping. */
export interface StrictInstructionMetadata {
  /** Exact source data length, including the discriminator. */
  data_length: number;
  /** Dense, exact description of every fixed source account. */
  fixed_accounts: StrictAccountConstraint[];
  /** Exact or bounded structured treatment of the source account suffix. */
  remaining_accounts: StrictRemainingAccounts;
}

/** A remapping instruction whose source and destination layouts are audited. */
export interface StrictInstruction extends Instruction {
  strict: StrictInstructionMetadata;
}

/** Versioned configuration consumed by the fail-closed mapper API. */
export interface StrictRemappingConfig
  extends Omit<RemappingConfig, "instructions"> {
  schema_version: 2;
  instructions: StrictInstruction[];
}

export type StrictRemappingConfigs = Record<string, StrictRemappingConfig>;

/** Numeric account roles used by Solana Kit instructions. */
export type SolanaKitAccountRole = 0 | 1 | 2 | 3;

/** Structural subset of a Solana Kit account meta required by the mapper. */
export interface SolanaKitAccountMeta {
  readonly address: string;
  readonly role: SolanaKitAccountRole;
}

/**
 * Structural Solana Kit instruction input.
 *
 * `data` is optional in Solana Kit's base `Instruction` type even though
 * executable protocol instructions provide it. Missing data fails closed at
 * runtime.
 */
export interface SolanaKitInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly SolanaKitAccountMeta[];
  readonly data?: ArrayLike<number>;
}

/** Inputs accepted by the strict mapper and its normalization helper. */
export type MappableInstruction =
  | TransactionInstruction
  | SolanaKitInstruction;

export interface MapInstructionOptions {
  /** Select the staging GLAM and proxy programs. Defaults to production. */
  staging?: boolean;
}

export type UnsupportedInstructionReason =
  | "unsupported-program"
  | "unsupported-instruction"
  | "invalid-instruction"
  | "invalid-data"
  | "account-count"
  | "account-meta"
  | "account-address"
  | "remaining-accounts"
  | "destination-invariant";

export interface MappedInstructionResult {
  kind: "mapped";
  instruction: TransactionInstruction;
  sourceInstructionName: string;
  destinationInstructionName: string;
}

/**
 * An instruction accepted unchanged by an audited schema-v2 passthrough rule.
 *
 * No passthrough rules ship in the initial schema-v2 configuration. Keeping
 * this result distinct prevents callers from treating unknown instructions as
 * safe merely because they did not need remapping.
 */
export interface SafePassthroughInstructionResult {
  kind: "safePassthrough";
  instruction: TransactionInstruction;
  sourceInstructionName: string;
}

export interface UnsupportedInstructionResult {
  kind: "unsupported";
  reason: UnsupportedInstructionReason;
  message: string;
}

export type MapInstructionResult =
  | MappedInstructionResult
  | SafePassthroughInstructionResult
  | UnsupportedInstructionResult;
