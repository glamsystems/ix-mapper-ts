import { isDynamicName, isPrefix } from "./document.js";
import { MappingDocumentError } from "./errors.js";
import type {
  Derivation,
  DynamicAccountName,
  MappedInstruction,
  MappingDocument,
  SuppliedAccount,
  SuppliedDestinationAccount,
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

/**
 * What the mapper asks the context's supplier for, once per mapped instruction whose entry
 * has supplied accounts, listed after the declared accounts or at an account index: the
 * roles, in the order the accounts are inserted, each with the addresses found at its `of`
 * positions, and the instruction itself for a supplier that reads its data. The supplier
 * answers with the accounts in the same order, the required ones first; it may leave out a
 * trailing run of optional ones. The accounts an entry supplies at an account index come
 * first, in account-index order, each required and with its derivation resolved; the mapper
 * places them at their account indexes.
 */
export interface SuppliedAccountsRequest {
  /** The GLAM program the mapped instruction targets. */
  readonly proxyProgram: string;
  /** The source program. */
  readonly program: string;
  /** The entry's name, the source instruction. */
  readonly source: string;
  /** The GLAM instruction that carries it. */
  readonly handler: string;
  /** The entry's supplied accounts, those at an account index first, with their `of` addresses. */
  readonly roles: readonly {
    readonly role: string;
    readonly of: readonly string[];
    readonly optional: boolean;
    /** For an account supplied at an account index, how it derives; absent when the IDL states nothing. */
    readonly derivation?: SuppliedAccountsRequestDerivation;
  }[];
  /** The source instruction as the caller passed it. */
  readonly instruction: NeutralInstruction;
}

/**
 * A derivation as the supplier receives it: the program, then the seeds in order, an account
 * seed resolved to the address the mapper placed at its account index and an argument seed
 * left as its path, which a supplier that reads the instruction data may resolve.
 */
export interface SuppliedAccountsRequestDerivation {
  readonly program: string;
  readonly seeds: readonly SuppliedAccountsRequestSeed[];
}

export type SuppliedAccountsRequestSeed =
  | { readonly kind: "const"; readonly value: readonly number[] }
  | { readonly kind: "account"; readonly address: string }
  | { readonly kind: "arg"; readonly path: string };

/** What a mapping needs from the caller: the GLAM accounts a document seats dynamically. */
export interface MappingContext {
  readonly glamState: string;
  readonly glamVault: string;
  readonly glamSigner: string;
  /** The integration authority of a proxy program, for a document that seats one. */
  readonly integrationAuthority?: (proxyProgram: string) => string | undefined;
  /**
   * The accounts a document lists as supplied, after the declared accounts or at an account
   * index, for an entry that has any: called once per such instruction, answering in the
   * request's order, the required ones first, a trailing run of optional ones left out at
   * will. No supplier or a nullish answer refuses the instruction with reason `context`; a
   * wrong count or a nullish account with `supplied_accounts`; a throw with `context`, never
   * as an escape.
   */
  readonly suppliedAccounts?: (
    request: SuppliedAccountsRequest,
  ) => readonly (string | null | undefined)[] | null | undefined;
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
  /** The context supplies no address for a GLAM account the document seats, or no accounts for an entry that has supplied ones. */
  | "context"
  /** The context supplied the wrong number of accounts for an entry that has supplied ones, or a null one. */
  | "supplied_accounts"
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
  // the accounts supplied at an account index, in account-index order, with where each
  // lands in `accounts` once the supplier answers
  const placed: {
    readonly account: SuppliedDestinationAccount;
    readonly at: number;
  }[] = [];
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
        // a caller-chosen signer keeps the caller's flag at an unsigned seat; a signing seat
        // needs it signed
        const signer =
          position.dynamic_signer === true && !seat.signer
            ? account.signer
            : seat.signer;
        if (account.signer !== signer) {
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
          signer,
        });
        break;
      }
      case "supplied":
        // held until the supplier answers, which it does once every account index is placed
        placed.push({ account: seat, at: accounts.length });
        accounts.push({ address: "", writable: seat.writable, signer: false });
        break;
    }
  }
  const supplied = entry.supplied_accounts ?? [];
  if (placed.length > 0 || supplied.length > 0) {
    const supplier = context.suppliedAccounts;
    if (supplier === undefined || supplier === null) {
      return refuse(
        "context",
        `the context supplies no accounts for ${source}`,
      );
    }
    const roles = [
      ...placed.map(({ account }) => ({
        role: account.role,
        of: [],
        optional: false,
        ...(account.derivation === undefined
          ? {}
          : { derivation: resolveDerivation(account.derivation, accounts) }),
      })),
      // every `of` position is inside the list and none is omittable, so the instruction
      // carries it: a shorter instruction was refused above; and no seat above was left out,
      // since an entry with a seat a client may leave out lists no supplied accounts
      ...supplied.map((account) => ({
        role: account.role,
        of: (account.of ?? []).map(
          (position) => instruction.accounts[position]!.address,
        ),
        optional: account.optional === true,
      })),
    ];
    const required =
      placed.length + supplied.filter((account) => !account.optional).length;
    let answer: readonly (string | null | undefined)[] | null | undefined;
    try {
      const raw = supplier({
        proxyProgram: document.proxy_program_id,
        program,
        source,
        handler: entry.handler.name,
        roles,
        instruction,
      });
      // read once, here: an answer that fails while it is read is the supplier's failure,
      // and so is one that is not an array, whatever an untyped caller returned
      if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
        throw new TypeError(
          "the supplier answered with something other than an array",
        );
      }
      answer = raw === null || raw === undefined ? raw : Array.from(raw);
    } catch (error) {
      return refuse(
        "context",
        `the context's supplied accounts failed for ${source}: ${error instanceof Error ? error.message : describe(error)}`,
      );
    }
    if (answer === null || answer === undefined) {
      return refuse(
        "context",
        `the context supplies no accounts for ${source}`,
      );
    }
    const max = placed.length + supplied.length;
    if (answer.length < required || answer.length > max) {
      return refuse(
        "supplied_accounts",
        `${source} takes ${required === max ? String(max) : `${required} to ${max}`}${max === 1 ? " supplied account (" : " supplied accounts ("}${roleNames(placed, supplied)}); the context supplied ${answer.length}`,
      );
    }
    for (let i = 0; i < answer.length; i++) {
      const address = answer[i];
      if (address === null || address === undefined) {
        return refuse(
          "supplied_accounts",
          `the context supplied a null account at ${i} for ${source}`,
        );
      }
      // the first answers go to their account indexes with the handler's writable flag
      const held = placed[i];
      if (held === undefined) {
        accounts.push({ address, writable: false, signer: false });
      } else {
        accounts[held.at] = {
          address,
          writable: held.account.writable,
          signer: false,
        };
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

/**
 * The roles of an entry's supplied accounts, comma-separated, those at an account index first
 * in account-index order, an optional one marked `?`: read from the document, never from the
 * request a supplier may have written over.
 */
function roleNames(
  placed: readonly { readonly account: SuppliedDestinationAccount }[],
  supplied: readonly SuppliedAccount[],
): string {
  return [
    ...placed.map(({ account }) => account.role),
    ...supplied.map((account) =>
      account.optional ? `${account.role}?` : account.role,
    ),
  ].join(", ");
}

/**
 * A derivation as the supplier receives it. An account seed names neither an account the
 * context supplies nor one a client may leave out, and only a trailing run of account
 * indexes is ever absent, so the account at that account index is the one in `accounts` at
 * the same index, as the mapper placed it.
 */
function resolveDerivation(
  derivation: Derivation,
  accounts: readonly NeutralAccount[],
): SuppliedAccountsRequestDerivation {
  return {
    program: derivation.program,
    seeds: derivation.seeds.map((seed): SuppliedAccountsRequestSeed => {
      switch (seed.kind) {
        case "const":
          return { kind: "const", value: [...seed.value] };
        case "account":
          return { kind: "account", address: accounts[seed.index]!.address };
        case "arg":
          return { kind: "arg", path: seed.path };
      }
    }),
  };
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
