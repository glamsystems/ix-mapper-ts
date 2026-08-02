import type {
  NeutralAccountMeta,
  NeutralInstruction,
  NeutralInstructionInput,
  NeutralMapperEnvironment,
  ReadonlyUint8Array,
  SolanaAccountRole,
} from "./core-types";

const MAX_INSTRUCTION_ACCOUNTS = 256;
const MAX_INSTRUCTION_DATA_BYTES = 1232;

function normalizeAddress(
  value: unknown,
  label: string,
  environment: NeutralMapperEnvironment,
): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    throw new TypeError(`${label} must be a bounded Solana address string`);
  }
  const normalized = environment.normalizeAddress(value);
  if (
    typeof normalized !== "string" ||
    normalized.length < 32 ||
    normalized.length > 44
  ) {
    throw new TypeError(`${label} did not normalize to a Solana address`);
  }
  return normalized;
}

function normalizeByteData(data: ReadonlyUint8Array | undefined): Uint8Array {
  if (
    data === undefined ||
    !(data instanceof Uint8Array) ||
    !Number.isSafeInteger(data.length) ||
    data.length < 0 ||
    data.length > MAX_INSTRUCTION_DATA_BYTES
  ) {
    throw new TypeError("Instruction data must be a bounded byte array");
  }
  const output = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError("Instruction data contains a non-byte value");
    }
    output[index] = byte;
  }
  return output;
}

function isAccountRole(value: unknown): value is SolanaAccountRole {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
}

function roleFromFlags(
  isWritable: boolean,
  isSigner: boolean,
): SolanaAccountRole {
  return ((isWritable ? 1 : 0) | (isSigner ? 2 : 0)) as SolanaAccountRole;
}

function isWritableRole(role: SolanaAccountRole): boolean {
  return (role & 1) !== 0;
}

function isSignerRole(role: SolanaAccountRole): boolean {
  return (role & 2) !== 0;
}

/** Copy and validate a client-neutral, Kit-compatible instruction. */
function normalizeInstructionNeutral(
  instruction: NeutralInstructionInput,
  environment: NeutralMapperEnvironment,
): NeutralInstruction {
  if (typeof instruction !== "object" || instruction === null) {
    throw new TypeError("Instruction must be an object");
  }

  const accounts = instruction.accounts ?? [];
  if (!Array.isArray(accounts) || accounts.length > MAX_INSTRUCTION_ACCOUNTS) {
    throw new TypeError("Solana Kit instruction has malformed accounts");
  }
  const normalizedAccounts: NeutralAccountMeta[] = accounts.map(
    (account, index) => {
      if (!account || !isAccountRole(account.role)) {
        throw new TypeError(`Solana Kit account ${index} has an invalid role`);
      }
      return {
        address: normalizeAddress(
          account.address,
          `Solana Kit account ${index}`,
          environment,
        ),
        role: account.role,
      };
    },
  );

  return {
    programAddress: normalizeAddress(
      instruction.programAddress,
      "Solana Kit program",
      environment,
    ),
    accounts: normalizedAccounts,
    data: normalizeByteData(instruction.data),
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesStartWith(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((byte, index) => data[index] === byte);
}

function concatBytes(
  prefix: readonly number[],
  payload: Uint8Array,
): Uint8Array {
  const output = new Uint8Array(prefix.length + payload.length);
  output.set(prefix, 0);
  output.set(payload, prefix.length);
  return output;
}

export {
  MAX_INSTRUCTION_ACCOUNTS,
  MAX_INSTRUCTION_DATA_BYTES,
  bytesEqual,
  bytesStartWith,
  concatBytes,
  isAccountRole,
  isSignerRole,
  isWritableRole,
  normalizeAddress,
  normalizeByteData,
  normalizeInstructionNeutral,
  roleFromFlags,
};
