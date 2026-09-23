import { MappingDocumentError } from "./errors.js";
import {
  DYNAMIC_ACCOUNT_NAMES,
  SCHEMA_VERSION,
  type DestinationAccount,
  type DynamicAccountName,
  type Handler,
  type InstructionEntry,
  type MappingDocument,
  type OptionalKind,
  type Provenance,
  type RemainingAccounts,
  type SourceAccount,
} from "./schema.js";

/**
 * Admits a parsed JSON value as a mapping document, refusing what a mapper could not act on
 * safely: an unknown field or label anywhere, a schema version this mapper does not know,
 * seats that are not dense from 0, a source position forwarded twice or forwarded read-only
 * while the native position is writable, an omittable optional ahead of a required
 * position, a seat after an omittable one or omittable seats out of source order, a
 * sentinel seat that does not forward an optional the client passes as the program id, an
 * unknown dynamic account, and a discriminator that is a prefix of another's, since
 * matching is by prefix.
 */
export function parseMappingDocument(
  value: unknown,
  label = "mapping document",
): MappingDocument {
  const object = asObject(value, label, [
    "schema_version",
    "environment",
    "program_id",
    "proxy_program_id",
    "provenance",
    "instructions",
  ]);
  if (object.schema_version !== SCHEMA_VERSION) {
    throw new MappingDocumentError(
      label,
      `schema_version ${String(object.schema_version)} is not ${SCHEMA_VERSION}`,
    );
  }
  const environment = nonBlankString(object.environment, label, "environment");
  const program_id = address(object.program_id, label, "program_id");
  const proxy_program_id = address(
    object.proxy_program_id,
    label,
    "proxy_program_id",
  );
  const at = `${label} ${program_id}`;
  const provenance =
    object.provenance === undefined
      ? undefined
      : parseProvenance(object.provenance, at);
  const instructions = asArray(object.instructions, at, "instructions").map(
    (entry, i) => parseEntry(entry, `${at} instructions[${i}]`),
  );
  for (let i = 0; i < instructions.length; i++) {
    for (let j = i + 1; j < instructions.length; j++) {
      const a = instructions[i]!;
      const b = instructions[j]!;
      const [shorter, longer] =
        a.discriminator.length <= b.discriminator.length ? [a, b] : [b, a];
      if (isPrefix(shorter.discriminator, longer.discriminator)) {
        throw new MappingDocumentError(
          at,
          `discriminator of ${shorter.name} ([${shorter.discriminator.join(", ")}]) is a prefix of ${longer.name}'s and would shadow it`,
        );
      }
    }
  }
  const document: MappingDocument =
    provenance === undefined
      ? {
          schema_version: SCHEMA_VERSION,
          environment,
          program_id,
          proxy_program_id,
          instructions,
        }
      : {
          schema_version: SCHEMA_VERSION,
          environment,
          program_id,
          proxy_program_id,
          provenance,
          instructions,
        };
  return document;
}

function parseProvenance(value: unknown, at: string): Provenance {
  const object = asObject(value, `${at} provenance`, [
    "generator",
    "source_idl",
    "proxy_idl",
    "config_revision",
  ]);
  const config_revision =
    object.config_revision === undefined
      ? 1
      : positiveInteger(
          object.config_revision,
          `${at} provenance`,
          "config_revision",
        );
  const provenance: { -readonly [K in keyof Provenance]: Provenance[K] } = {
    config_revision,
  };
  if (object.generator !== undefined)
    provenance.generator = nonBlankString(
      object.generator,
      `${at} provenance`,
      "generator",
    );
  if (object.source_idl !== undefined)
    provenance.source_idl = nonBlankString(
      object.source_idl,
      `${at} provenance`,
      "source_idl",
    );
  if (object.proxy_idl !== undefined)
    provenance.proxy_idl = nonBlankString(
      object.proxy_idl,
      `${at} provenance`,
      "proxy_idl",
    );
  return provenance;
}

function parseEntry(value: unknown, at: string): InstructionEntry {
  const object = asObject(value, at, [
    "name",
    "discriminator",
    "disposition",
    "reason",
    "handler",
    "source_accounts",
    "destination_accounts",
    "remaining_accounts",
  ]);
  const name = nonBlankString(object.name, at, "name");
  const discriminator = byteArray(object.discriminator, at, "discriminator");
  if (discriminator.length === 0) {
    throw new MappingDocumentError(at, `${name} has no discriminator`);
  }
  const disposition = object.disposition;
  switch (disposition) {
    case "passthrough":
    case "unsupported": {
      refuseKeys(
        object,
        at,
        [
          "handler",
          "source_accounts",
          "destination_accounts",
          "remaining_accounts",
        ],
        `a ${disposition} entry`,
      );
      const reason = nonBlankString(object.reason, at, "reason");
      return { name, discriminator, disposition, reason };
    }
    case "map": {
      refuseKeys(object, at, ["reason"], "a map entry");
      const handler = parseHandler(object.handler, `${at} handler`);
      const sources = asArray(object.source_accounts, at, "source_accounts");
      const seats = asArray(
        object.destination_accounts,
        at,
        "destination_accounts",
      );
      const source_accounts = sources.map((source, i) =>
        parseSourceAccount(source, `${at} source_accounts[${i}]`),
      );
      const destination_accounts = seats.map((seat, i) =>
        parseSeat(seat, `${at} destination_accounts[${i}]`),
      );
      const remaining_accounts =
        object.remaining_accounts === undefined
          ? ({ kind: "any" } as const)
          : parseRemaining(
              object.remaining_accounts,
              `${at} remaining_accounts`,
            );
      validateShape(source_accounts, destination_accounts, at);
      return {
        name,
        discriminator,
        disposition: "map",
        handler,
        source_accounts,
        destination_accounts,
        remaining_accounts,
      };
    }
    case undefined:
      throw new MappingDocumentError(at, `${name} has no disposition`);
    default:
      throw new MappingDocumentError(
        at,
        `${name} has unknown disposition ${String(disposition)}`,
      );
  }
}

function parseHandler(value: unknown, at: string): Handler {
  const object = asObject(value, at, ["name", "discriminator"]);
  const discriminator = byteArray(object.discriminator, at, "discriminator");
  if (discriminator.length === 0) {
    throw new MappingDocumentError(at, "the handler has no discriminator");
  }
  return { name: nonBlankString(object.name, at, "name"), discriminator };
}

function parseSourceAccount(value: unknown, at: string): SourceAccount {
  const object = asObject(value, at, [
    "name",
    "writable",
    "signer",
    "dynamic_signer",
    "optional",
    "expect",
  ]);
  const account: { -readonly [K in keyof SourceAccount]: SourceAccount[K] } = {
    name: nonBlankString(object.name, at, "name"),
    writable: bool(object.writable, at, "writable"),
    signer: bool(object.signer, at, "signer"),
  };
  if (object.dynamic_signer !== undefined) {
    if (object.dynamic_signer !== true)
      throw new MappingDocumentError(
        at,
        "dynamic_signer must be true when present",
      );
    account.dynamic_signer = true;
  }
  if (object.optional !== undefined) {
    if (object.optional !== "omitted" && object.optional !== "program_id") {
      throw new MappingDocumentError(
        at,
        `unknown optional kind ${String(object.optional)}`,
      );
    }
    account.optional = object.optional as OptionalKind;
  }
  if (object.expect !== undefined) {
    const expect = nonBlankString(object.expect, at, "expect");
    if (!isDynamicName(expect) && !looksLikeAddress(expect)) {
      throw new MappingDocumentError(
        at,
        `expect ${expect} is neither a dynamic account nor an address`,
      );
    }
    account.expect = expect;
  }
  return account;
}

function parseSeat(value: unknown, at: string): DestinationAccount {
  const object = asObject(value, at, [
    "index",
    "kind",
    "name",
    "address",
    "source",
    "writable",
    "signer",
    "sentinel",
  ]);
  const index = nonNegativeInteger(object.index, at, "index");
  const writable = bool(object.writable, at, "writable");
  const signer = bool(object.signer, at, "signer");
  switch (object.kind) {
    case "dynamic": {
      refuseKeys(
        object,
        at,
        ["address", "source", "sentinel"],
        "a dynamic seat",
      );
      const name = nonBlankString(object.name, at, "name");
      if (!isDynamicName(name))
        throw new MappingDocumentError(at, `unknown dynamic account ${name}`);
      return { index, kind: "dynamic", name, writable, signer };
    }
    case "static": {
      refuseKeys(object, at, ["name", "source", "sentinel"], "a static seat");
      return {
        index,
        kind: "static",
        address: address(object.address, at, "address"),
        writable,
        signer,
      };
    }
    case "source": {
      refuseKeys(object, at, ["name", "address"], "a source seat");
      const source = nonNegativeInteger(object.source, at, "source");
      if (object.sentinel === undefined)
        return { index, kind: "source", source, writable, signer };
      if (object.sentinel !== true)
        throw new MappingDocumentError(
          at,
          "sentinel must be true when present",
        );
      return {
        index,
        kind: "source",
        source,
        writable,
        signer,
        sentinel: true,
      };
    }
    case undefined:
      throw new MappingDocumentError(at, "the seat has no kind");
    default:
      throw new MappingDocumentError(
        at,
        `unknown seat kind ${String(object.kind)}`,
      );
  }
}

function parseRemaining(value: unknown, at: string): RemainingAccounts {
  const object = asObject(value, at, ["kind"]);
  if (object.kind !== "any" && object.kind !== "none") {
    throw new MappingDocumentError(
      at,
      `unknown remaining-accounts kind ${String(object.kind)}`,
    );
  }
  return { kind: object.kind };
}

/** The invariants over a map entry's positions and seats. */
function validateShape(
  sources: readonly SourceAccount[],
  seats: readonly DestinationAccount[],
  at: string,
): void {
  const seen = new Array<boolean>(seats.length).fill(false);
  const forwarded = new Array<boolean>(sources.length).fill(false);
  for (const seat of seats) {
    if (seat.index >= seats.length) {
      throw new MappingDocumentError(
        at,
        `seats are not dense from 0: seat ${seat.index} of ${seats.length}`,
      );
    }
    if (seen[seat.index]) {
      throw new MappingDocumentError(at, `seat ${seat.index} is listed twice`);
    }
    seen[seat.index] = true;
    if (seat.kind === "source") {
      if (seat.source >= sources.length) {
        throw new MappingDocumentError(
          at,
          `seat ${seat.index} forwards source position ${seat.source}, which is out of range of ${sources.length}`,
        );
      }
      if (forwarded[seat.source]) {
        throw new MappingDocumentError(
          at,
          `seat ${seat.index} forwards source position ${seat.source}, which is already forwarded`,
        );
      }
      forwarded[seat.source] = true;
      if (!seat.writable && sources[seat.source]!.writable) {
        // the handler passes the account on with the flags it received, so a read-only seat
        // would deny the native program a write its own IDL declares
        throw new MappingDocumentError(
          at,
          `seat ${seat.index} forwards source position ${seat.source} read-only, which the native instruction declares writable`,
        );
      }
      if (seat.sentinel && sources[seat.source]!.optional !== "program_id") {
        throw new MappingDocumentError(
          at,
          `seat ${seat.index} rewrites a sentinel, but source position ${seat.source} is not an optional the client passes as the program id`,
        );
      }
    }
  }
  let omittedSeen = false;
  sources.forEach((source, i) => {
    if (source.optional === "omitted") {
      omittedSeen = true;
    } else if (omittedSeen) {
      throw new MappingDocumentError(
        at,
        `source position ${i} follows an omittable optional; a client that leaves it out shifts this position`,
      );
    }
  });
  // Omittable seats come last, and in source order: a client may leave out only a trailing
  // run of positions, so an absent position must never be followed by a present seat.
  let omittableSeen = false;
  let lastOmittableSource = -1;
  for (const seat of [...seats].sort((a, b) => a.index - b.index)) {
    const omittable =
      seat.kind === "source" && sources[seat.source]!.optional === "omitted";
    if (omittable) {
      omittableSeen = true;
      if (seat.source <= lastOmittableSource) {
        throw new MappingDocumentError(
          at,
          `seat ${seat.index} forwards omittable position ${seat.source} after position ${lastOmittableSource}; an absent run would shift it`,
        );
      }
      lastOmittableSource = seat.source;
    } else if (omittableSeen) {
      throw new MappingDocumentError(
        at,
        `seat ${seat.index} follows a seat a client may leave out; an absent one would shift it`,
      );
    }
  }
}

export function isDynamicName(value: string): value is DynamicAccountName {
  return (DYNAMIC_ACCOUNT_NAMES as readonly string[]).includes(value);
}

const ADDRESS_CHARACTERS = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * An address is 32 to 44 characters of the base58 alphabet. That they decode to 32 bytes is
 * the caller's address library's to decide; the adapters report its refusal as a result.
 */
export function looksLikeAddress(value: string): boolean {
  return (
    value.length >= 32 && value.length <= 44 && ADDRESS_CHARACTERS.test(value)
  );
}

export function isPrefix(
  shorter: readonly number[],
  longer: readonly number[],
): boolean {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

function asObject(
  value: unknown,
  at: string,
  known: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MappingDocumentError(at, "must be an object");
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!known.includes(key))
      throw new MappingDocumentError(at, `unknown field "${key}"`);
  }
  return object;
}

function refuseKeys(
  object: Record<string, unknown>,
  at: string,
  keys: readonly string[],
  what: string,
): void {
  for (const key of keys) {
    if (object[key] !== undefined)
      throw new MappingDocumentError(at, `${what} carries no "${key}"`);
  }
}

/** An array with an element at every index: a hole is a malformed value, not an absent entry. */
function asArray(value: unknown, at: string, field: string): unknown[] {
  if (!Array.isArray(value))
    throw new MappingDocumentError(at, `${field} must be an array`);
  for (let i = 0; i < value.length; i++) {
    if (!(i in value))
      throw new MappingDocumentError(at, `${field}[${i}] is missing`);
  }
  return value;
}

function nonBlankString(value: unknown, at: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MappingDocumentError(at, `${field} must be a non-blank string`);
  }
  return value;
}

function address(value: unknown, at: string, field: string): string {
  const text = nonBlankString(value, at, field);
  if (!looksLikeAddress(text))
    throw new MappingDocumentError(at, `${field} is not an address`);
  return text;
}

function bool(value: unknown, at: string, field: string): boolean {
  if (typeof value !== "boolean")
    throw new MappingDocumentError(at, `${field} must be a boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, at: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MappingDocumentError(
      at,
      `${field} must be a non-negative integer`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, at: string, field: string): number {
  const n = nonNegativeInteger(value, at, field);
  if (n === 0)
    throw new MappingDocumentError(at, `${field} must be a positive integer`);
  return n;
}

function byteArray(value: unknown, at: string, field: string): number[] {
  return asArray(value, at, field).map((byte, i) => {
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    ) {
      throw new MappingDocumentError(at, `${field}[${i}] is not a byte`);
    }
    return byte;
  });
}
