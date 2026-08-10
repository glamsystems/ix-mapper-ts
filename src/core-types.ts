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
  /**
   * Optional client-binding primitive used by operation profiles that must
   * prove an associated token address. The neutral mapper supplies all four
   * inputs; the binding only performs the deterministic PDA derivation.
   */
  deriveAssociatedTokenAddress?(input: {
    readonly ownerAddress: string;
    readonly mintAddress: string;
    readonly tokenProgramAddress: string;
    readonly associatedTokenProgramAddress: string;
  }): Promise<string>;
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

export type KaminoKvaultOperationName = "deposit" | "withdraw";
export type KaminoLendingOperationName = "repayObligationLiquidityV2";
/** Active runtime tuple. Kamino 10 remains evaluation-only. */
export type KaminoLendingSdkVersion = "9.1.5";

/** Complete, ordered helper emission for one supported KVault operation. */
export interface MapKaminoKvaultOperationInput {
  readonly operation: KaminoKvaultOperationName;
  readonly instructions: readonly NeutralInstructionInput[];
  /** Payer/signing account used by the native ATA setup instruction. */
  readonly ataPayerAddress: string;
}

/** Oracle identities decoded from one reviewed Kamino reserve account. */
export interface KaminoLendingReserveRefreshBinding {
  readonly reserveAddress: string;
  readonly pythOracleAddress: string | null;
  readonly switchboardPriceOracleAddress: string | null;
  readonly switchboardTwapOracleAddress: string | null;
  /** The first profile deliberately excludes Scope-priced reserves. */
  readonly scopePricesAddress: null;
}

/**
 * Reviewed state relationships supplied by the official SDK/bounded binding.
 *
 * The neutral mapper never fetches or decodes protocol state. It binds the
 * immutable instruction list to this caller-owned snapshot before returning
 * any mapped result.
 */
export interface KaminoLendingRepayContext {
  /** Slot attached to the decoded account snapshot. */
  readonly stateObservationSlot: bigint;
  /** Slot observed immediately before building the immutable operation. */
  readonly currentSlot: bigint;
  readonly elevationGroup: 0;
  readonly hasActiveFarms: false;
  readonly hasFixedTermDebt: false;
  readonly referrerAddress: null;
  readonly sourceAtaExists: true;
  readonly lendingMarketAddress: string;
  readonly obligationAddress: string;
  readonly repayReserveAddress: string;
  readonly reserveLiquidityMintAddress: string;
  readonly reserveDestinationLiquidityAddress: string;
  readonly userSourceLiquidityAddress: string;
  readonly lendingMarketAuthorityAddress: string;
  readonly depositReserveAddresses: readonly string[];
  readonly borrowReserveAddresses: readonly string[];
  readonly reserveRefreshBindings: readonly KaminoLendingReserveRefreshBinding[];
}

/** Complete official-helper emission for the first bounded Klend operation. */
export interface MapKaminoLendingRepayOperationInput {
  readonly operation: KaminoLendingOperationName;
  readonly officialSdkVersion: KaminoLendingSdkVersion;
  readonly instructions: readonly NeutralInstructionInput[];
  readonly reviewedContext: KaminoLendingRepayContext;
}

export type OperationSetupBinding =
  | "ata_payer"
  | "derived_associated_token_account"
  | "glam_vault"
  | "protocol_token_mint"
  | "protocol_token_program";

export interface OperationProfileSetupAccount {
  readonly index: number;
  readonly role: SolanaAccountRole;
  readonly account?: string;
  readonly binding?: OperationSetupBinding;
}

export interface OperationProfileConfig {
  readonly $schema?: string;
  readonly schema_version: 1;
  readonly config_revision: number;
  readonly integration: "kamino-kvaults";
  readonly operations: readonly {
    readonly id: string;
    readonly operation: KaminoKvaultOperationName;
    readonly official_emitter: string;
    readonly bounded_binding: string;
    readonly setup: {
      readonly outcome: "operationBoundPassthrough";
      readonly position: 0;
      readonly program_id: string;
      readonly instruction: string;
      readonly exact_data: readonly number[];
      readonly accounts: readonly OperationProfileSetupAccount[];
    };
    readonly protocol: {
      readonly start_position: 1;
      readonly source_instruction: "deposit" | "withdraw";
      readonly minimum_count: number;
      readonly maximum_count: number;
      readonly owner_account_index: number;
      readonly token_account_index: number;
      readonly token_mint_index: number;
      readonly token_program_index: number;
      readonly forbidden_mint_account_indices: readonly number[];
      readonly forbidden_mints: readonly string[];
    };
  }[];
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
  | "destination-invariant"
  | "operation-shape"
  | "operation-binding";

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

export interface NeutralMappedOperationResult {
  kind: "mappedOperation";
  operation: KaminoKvaultOperationName | KaminoLendingOperationName;
  instructions: readonly (
    | NeutralMappedInstructionResult
    | NeutralSafePassthroughInstructionResult
  )[];
}

export interface UnsupportedOperationResult
  extends UnsupportedInstructionResult {
  /** Index in the presented operation, or null for an operation-wide failure. */
  instructionIndex: number | null;
}

export type NeutralMapOperationResult =
  | NeutralMappedOperationResult
  | UnsupportedOperationResult;

/** Backward-compatible aliases for the original structural Kit input types. */
export type SolanaKitAccountRole = SolanaAccountRole;
export type SolanaKitAccountMeta = NeutralAccountMeta;
