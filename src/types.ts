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
