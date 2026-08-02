export interface Account {
  name?: string;
  account?: string;
  index: number;
  writable: boolean;
  signer: boolean;
}

export interface DynamicAccount extends Account {
  name: string;
}

export interface StaticAccount extends Account {
  account: string;
}

export interface Instruction {
  src_ix_name: string;
  src_discriminator: number[];
  dst_ix_name: string;
  dst_discriminator: number[];
  dynamic_accounts: DynamicAccount[];
  static_accounts: StaticAccount[];
  index_map: number[];
  program_id_placeholder_indices?: number[];
}

export interface RemappingConfig {
  program_id: string;
  proxy_program_id: string;
  instructions: Instruction[];
}

export type RemappingConfigs = Record<string, RemappingConfig>;

export type StrictDynamicAccountName =
  | "glam_state"
  | "glam_vault"
  | "glam_signer"
  | "integration_authority";

export interface StrictAccountConstraint {
  index: number;
  writable: boolean;
  signer: boolean;
  account?: string;
  one_of_accounts?: string[];
  same_as?: number;
  dynamic_account?: StrictDynamicAccountName;
}

export interface StrictRemainingAccountMeta {
  writable: boolean;
  signer: boolean;
}

export interface StrictNoRemainingAccounts {
  kind: "none";
}

export interface StrictPairedRemainingAccounts {
  kind: "paired_segments";
  first: StrictRemainingAccountMeta;
  second: StrictRemainingAccountMeta;
  min_per_segment?: number;
  max_per_segment: number;
}

export type StrictRemainingAccounts =
  | StrictNoRemainingAccounts
  | StrictPairedRemainingAccounts;

export interface StrictInstructionMetadata {
  data_length: number;
  fixed_accounts: StrictAccountConstraint[];
  remaining_accounts: StrictRemainingAccounts;
}

export interface StrictInstruction extends Instruction {
  strict: StrictInstructionMetadata;
}

/** Exact data accepted by a native safe-passthrough rule. */
export interface StrictExactDataConstraint {
  kind: "exact";
  bytes: number[];
}

export interface StrictRemappingConfig {
  schema_version: 2;
  config_revision: number;
  program_id: string;
  proxy_program_id: string;
  instructions: StrictInstruction[];
}

export type StrictRemappingConfigs = Record<string, StrictRemappingConfig>;

export type InstructionClassificationPhase = "protocol" | "setup" | "cleanup";

interface InstructionClassificationBase {
  id: string;
  program_id: string;
  instruction: string;
  phase: InstructionClassificationPhase;
  emitted_by: string[];
  condition: string;
}

export interface MappedInstructionClassification
  extends InstructionClassificationBase {
  outcome: "mapped";
  discriminator: number[];
  mapping_ref: {
    config_schema_version: 2;
    config_revision: number;
    source_instruction: string;
  };
}

export interface SafePassthroughInstructionClassification
  extends InstructionClassificationBase {
  outcome: "safePassthrough";
  discriminator: number[];
  rationale: string;
  strict: {
    data: StrictExactDataConstraint;
    fixed_accounts: StrictAccountConstraint[];
    remaining_accounts: StrictNoRemainingAccounts;
  };
}

export interface UnsupportedInstructionClassification
  extends InstructionClassificationBase {
  outcome: "unsupported";
  discriminator?: number[];
  reason: string;
}

export type InstructionClassification =
  | MappedInstructionClassification
  | SafePassthroughInstructionClassification
  | UnsupportedInstructionClassification;

export interface InstructionClassificationConfig {
  $schema?: string;
  schema_version: 1;
  config_revision: number;
  integration: string;
  rules: InstructionClassification[];
}

/** Numeric Solana roles: readonly, writable, signer, writable signer. */
export type SolanaAccountRole = 0 | 1 | 2 | 3;

/** Client-neutral account meta, structurally compatible with Solana Kit. */
export interface NeutralAccountMeta {
  readonly address: string;
  readonly role: SolanaAccountRole;
}

/** Canonical instruction produced by the strict mapper. */
export interface NeutralInstruction {
  readonly programAddress: string;
  readonly accounts: readonly NeutralAccountMeta[];
  readonly data: Uint8Array;
}

/** Mutable methods removed from Kit's readonly byte-view contract. */
export type ReadonlyUint8Array = Omit<
  Uint8Array,
  "copyWithin" | "fill" | "reverse" | "set" | "sort"
>;

/** Structural instruction input accepted without a client-library dependency. */
export interface NeutralInstructionInput {
  readonly programAddress: string;
  readonly accounts?: readonly NeutralAccountMeta[];
  readonly data?: ReadonlyUint8Array;
}

/** Runtime address validation supplied by a client binding. */
export interface NeutralMapperEnvironment {
  normalizeAddress(address: string): string;
}

/**
 * All GLAM-owned addresses needed by the synchronous neutral mapper.
 *
 * The GLAM SDK Kit binding derives these addresses. The legacy web3.js binding
 * derives the same values with PublicKey.findProgramAddressSync.
 */
export interface NeutralMappingContext {
  readonly glamStateAddress: string;
  readonly glamVaultAddress: string;
  readonly glamSignerAddress: string;
  readonly integrationAuthorityByProxyProgram: Readonly<Record<string, string>>;
}

export interface MapInstructionOptions {
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

export interface NeutralMappedInstructionResult {
  kind: "mapped";
  instruction: NeutralInstruction;
  sourceInstructionName: string;
  destinationInstructionName: string;
}

export interface NeutralSafePassthroughInstructionResult {
  kind: "safePassthrough";
  instruction: NeutralInstruction;
  sourceInstructionName: string;
}

export interface UnsupportedInstructionResult {
  kind: "unsupported";
  reason: UnsupportedInstructionReason;
  message: string;
}

export type NeutralMapInstructionResult =
  | NeutralMappedInstructionResult
  | NeutralSafePassthroughInstructionResult
  | UnsupportedInstructionResult;

/** Backward-compatible aliases for the original structural Kit input types. */
export type SolanaKitAccountRole = SolanaAccountRole;
export type SolanaKitAccountMeta = NeutralAccountMeta;
