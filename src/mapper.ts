import { isDynamicName, isPrefix } from "./document.js";
import { MappingDocumentError } from "./errors.js";
import type {
  DynamicAccountName,
  MappedInstruction,
  MappingDocument,
} from "./schema.js";

/** An account of an instruction, in the terms every instruction shape shares. */
export interface NeutralAccount {
  readonly address: string;
  readonly writable: boolean;
  readonly signer: boolean;
}

/** An instruction in the terms every instruction shape shares: a program, accounts, bytes. */
export interface NeutralInstruction {
  readonly programAddress: string;
  readonly accounts: readonly NeutralAccount[];
  readonly data: Uint8Array;
}

/** What a mapping needs from the caller: the GLAM accounts a document seats dynamically. */
export interface MappingContext {
  readonly glamState: string;
  readonly glamVault: string;
  readonly glamSigner: string;
  /** The integration authority of a proxy program, for a document that seats one. */
  readonly integrationAuthority?: (proxyProgram: string) => string | undefined;
}

export type UnsupportedReason =
  /** The program has a document, but no entry matches the instruction data. */
  | "unknown_instruction"
  /** The document refuses the instruction; the message carries its reason. */
  | "refused_instruction"
  /** The instruction leaves out an account the document needs. */
  | "account_count"
  /** An account is not the one the document expects at its position. */
  | "account_expectation"
  /** A forwarded account's signer privilege disagrees with the seat it fills. */
  | "account_privilege"
  /** The instruction carries accounts beyond the list and the document forbids them. */
  | "remaining_accounts"
  /** The context supplies no address for a GLAM account the document seats. */
  | "context"
  /** The caller's address library refused an address of the mapped instruction. */
  | "address";

export type MapResult =
  | {
      readonly kind: "mapped";
      readonly instruction: NeutralInstruction;
      readonly program: string;
      readonly source: string;
      readonly handler: string;
    }
  | {
      readonly kind: "passthrough";
      readonly instruction: NeutralInstruction;
      readonly program: string;
      /** The document entry, or undefined when the program has no document at all. */
      readonly source?: string;
      readonly reason: string;
    }
  | {
      readonly kind: "unsupported";
      readonly program: string;
      readonly source?: string;
      readonly reason: UnsupportedReason;
      readonly message: string;
    };

export interface Mapper {
  readonly environment: string;
  readonly documents: readonly MappingDocument[];
  /** Maps one instruction; never throws, every outcome is a result. */
  map(instruction: NeutralInstruction, context: MappingContext): MapResult;
  /** The document of a program, when the mapper holds one. */
  documentOf(programAddress: string): MappingDocument | undefined;
}

/**
 * A mapper over admitted documents of one environment; `createMapper` admits them first. An
 * instruction of a program with no document passes through: the program is not one GLAM
 * proxies. An instruction of a documented program follows its entry, and one no entry
 * matches is refused. Throws `MappingDocumentError` for a set that forms no mapper: none,
 * two environments, or two documents for one program.
 */
export function createMapperOver(
  documents: readonly MappingDocument[],
): Mapper {
  if (documents.length === 0) {
    throw new MappingDocumentError(
      "mapper",
      "at least one mapping document is required",
    );
  }
  const byProgram = new Map<string, MappingDocument>();
  const environment = documents[0]!.environment;
  for (const document of documents) {
    if (document.environment !== environment) {
      throw new MappingDocumentError(
        document.program_id,
        `declares environment ${document.environment}; the mapper's is ${environment}`,
      );
    }
    if (byProgram.has(document.program_id)) {
      throw new MappingDocumentError(
        document.program_id,
        "two documents for one program",
      );
    }
    byProgram.set(document.program_id, document);
  }
  return {
    environment,
    documents: [...documents],
    documentOf: (programAddress) => byProgram.get(programAddress),
    map: (instruction, context) =>
      mapInstruction(byProgram, instruction, context),
  };
}

function mapInstruction(
  byProgram: ReadonlyMap<string, MappingDocument>,
  instruction: NeutralInstruction,
  context: MappingContext,
): MapResult {
  const program = instruction.programAddress;
  const document = byProgram.get(program);
  if (document === undefined) {
    return {
      kind: "passthrough",
      instruction,
      program,
      reason: "the program has no mapping document",
    };
  }
  const entry = document.instructions.find((candidate) =>
    startsWith(instruction.data, candidate.discriminator),
  );
  if (entry === undefined) {
    return {
      kind: "unsupported",
      program,
      reason: "unknown_instruction",
      message: `no instruction of ${program} matches the data`,
    };
  }
  switch (entry.disposition) {
    case "passthrough":
      return {
        kind: "passthrough",
        instruction,
        program,
        source: entry.name,
        reason: entry.reason,
      };
    case "unsupported":
      return {
        kind: "unsupported",
        program,
        source: entry.name,
        reason: "refused_instruction",
        message: entry.reason,
      };
    case "map":
      return mapEntry(document, entry, instruction, context);
  }
}

function mapEntry(
  document: MappingDocument,
  entry: MappedInstruction,
  instruction: NeutralInstruction,
  context: MappingContext,
): MapResult {
  const program = instruction.programAddress;
  const source = entry.name;
  const refuse = (reason: UnsupportedReason, message: string): MapResult => ({
    kind: "unsupported",
    program,
    source,
    reason,
    message,
  });
  const positions = entry.source_accounts;
  const provided = instruction.accounts.length;
  for (let i = provided; i < positions.length; i++) {
    if (positions[i]!.optional !== "omitted") {
      return refuse(
        "account_count",
        `${source} needs account ${i} (${positions[i]!.name}); the instruction carries ${provided}`,
      );
    }
  }
  for (let i = 0; i < Math.min(provided, positions.length); i++) {
    const position = positions[i]!;
    if (position.expect === undefined) continue;
    const expected = isDynamicName(position.expect)
      ? dynamicAddress(position.expect, document, context)
      : position.expect;
    if (expected === undefined) {
      return refuse(
        "context",
        `the context supplies no ${position.expect} for ${document.proxy_program_id}`,
      );
    }
    if (expected instanceof Error) {
      return refuse(
        "context",
        `the context's integration authority failed for ${document.proxy_program_id}: ${expected.message}`,
      );
    }
    if (instruction.accounts[i]!.address !== expected) {
      return refuse(
        "account_expectation",
        `${source} account ${i} (${position.name}) must be ${position.expect}`,
      );
    }
  }
  const accounts: NeutralAccount[] = [];
  let absentSeatSeen = false;
  for (const seat of [...entry.destination_accounts].sort(
    (a, b) => a.index - b.index,
  )) {
    const absent = seat.kind === "source" && seat.source >= provided;
    if (absentSeatSeen && !absent) {
      // the document orders omittable seats after every other and in source order, so an
      // absent one is followed only by absent ones; anything else would shift a seat
      return refuse(
        "account_count",
        `${source} leaves out an account ahead of one it carries; seat ${seat.index} would shift`,
      );
    }
    switch (seat.kind) {
      case "dynamic": {
        const address = dynamicAddress(seat.name, document, context);
        if (address === undefined) {
          return refuse(
            "context",
            `the context supplies no ${seat.name} for ${document.proxy_program_id}`,
          );
        }
        if (address instanceof Error) {
          return refuse(
            "context",
            `the context's integration authority failed for ${document.proxy_program_id}: ${address.message}`,
          );
        }
        accounts.push({
          address,
          writable: seat.writable,
          signer: seat.signer,
        });
        break;
      }
      case "static":
        accounts.push({
          address: seat.address,
          writable: seat.writable,
          signer: seat.signer,
        });
        break;
      case "source": {
        if (absent) {
          // an omittable optional the client left out
          absentSeatSeen = true;
          break;
        }
        const account = instruction.accounts[seat.source]!;
        const position = positions[seat.source]!;
        if (seat.sentinel === true && account.address === program) {
          // an absent optional of the handler's own: the proxy program's id, read-only and
          // unsigned, as Anchor clients pass one, whatever the seat declares for a present
          // account; the invoked program is never writable and never signs
          accounts.push({
            address: document.proxy_program_id,
            writable: false,
            signer: false,
          });
          break;
        }
        if (
          position.dynamic_signer !== true &&
          account.signer !== seat.signer
        ) {
          return refuse(
            "account_privilege",
            seat.signer
              ? `${source} account ${seat.source} (${position.name}) must sign`
              : `${source} account ${seat.source} (${position.name}) signs, but the handler takes it unsigned`,
          );
        }
        accounts.push({
          address: account.address,
          writable: seat.writable,
          signer: seat.signer,
        });
        break;
      }
    }
  }
  if (provided > positions.length) {
    if (entry.remaining_accounts.kind === "none") {
      return refuse(
        "remaining_accounts",
        `${source} takes no accounts beyond its ${positions.length}; the instruction carries ${provided}`,
      );
    }
    for (let i = positions.length; i < provided; i++) {
      const account = instruction.accounts[i]!;
      accounts.push({
        address: account.address,
        writable: account.writable,
        signer: account.signer,
      });
    }
  }
  const discriminator = entry.handler.discriminator;
  const payload = instruction.data.subarray(entry.discriminator.length);
  const data = new Uint8Array(discriminator.length + payload.length);
  data.set(discriminator, 0);
  data.set(payload, discriminator.length);
  return {
    kind: "mapped",
    instruction: { programAddress: document.proxy_program_id, accounts, data },
    program,
    source,
    handler: entry.handler.name,
  };
}

/** The address of a GLAM account from the context; an Error when the caller's lookup threw. */
function dynamicAddress(
  name: DynamicAccountName,
  document: MappingDocument,
  context: MappingContext,
): string | undefined | Error {
  switch (name) {
    case "glam_state":
      return context.glamState;
    case "glam_vault":
      return context.glamVault;
    case "glam_signer":
      return context.glamSigner;
    case "integration_authority":
      try {
        return context.integrationAuthority?.(document.proxy_program_id);
      } catch (error) {
        return error instanceof Error ? error : new Error(describe(error));
      }
  }
}

/** A thrown value as text, for a value that refuses conversion. */
export function describe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "a value that cannot be described";
  }
}

function startsWith(
  data: Uint8Array,
  discriminator: readonly number[],
): boolean {
  if (data.length < discriminator.length) return false;
  return isPrefix(
    discriminator,
    Array.from(data.subarray(0, discriminator.length)),
  );
}
