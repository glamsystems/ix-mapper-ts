import { parseMappingDocument } from "./document.js";
import {
  PRODUCTION_DOCUMENTS,
  STAGING_DOCUMENTS,
} from "./generated/mapping/index.js";
import { createMapperOver, type Mapper } from "./mapper.js";
import type { MappingDocument } from "./schema.js";

export type {
  DestinationAccount,
  DynamicAccountName,
  DynamicSeat,
  Handler,
  InstructionEntry,
  MappedInstruction,
  MappingDocument,
  OptionalKind,
  PassthroughInstruction,
  Provenance,
  RemainingAccounts,
  SourceAccount,
  SourceSeat,
  StaticSeat,
  UnsupportedInstruction,
} from "./schema.js";
export { DYNAMIC_ACCOUNT_NAMES, SCHEMA_VERSION } from "./schema.js";
export { parseMappingDocument } from "./document.js";
export { MappingDocumentError } from "./errors.js";
export type {
  Mapper,
  MappingContext,
  MapResult,
  NeutralAccount,
  NeutralInstruction,
  UnsupportedReason,
} from "./mapper.js";
export type {
  KitAccountMetaLike,
  KitInstruction,
  KitInstructionLike,
  KitMappedAccount,
  KitMapResult,
  KitRole,
  KitSignerOf,
  KitSigningRole,
} from "./kit.js";
export {
  fromKitInstruction,
  mapKitInstruction,
  roleOf,
  toKitInstruction,
} from "./kit.js";

export type Environment = "production" | "staging";

/** The bundled documents of an environment, generated from the GLAM programs' IDLs. */
export function mappingDocuments(
  environment: Environment,
): readonly MappingDocument[] {
  switch (environment) {
    case "production":
      return PRODUCTION_DOCUMENTS;
    case "staging":
      return STAGING_DOCUMENTS;
  }
}

export type CreateMapperOptions =
  /** The bundled documents of an environment. */
  | { readonly environment: Environment; readonly documents?: never }
  /**
   * Documents of the caller's own, parsed JSON or already admitted; each is admitted
   * through `parseMappingDocument` here, so a document that does not admit throws.
   */
  | { readonly documents: readonly unknown[]; readonly environment?: never };

/**
 * A mapper over the bundled documents of an environment, or over documents the caller
 * supplies. Throws `MappingDocumentError` when a caller document does not admit, or when
 * the set forms no mapper: none, two environments, or two documents for one program.
 */
export function createMapper(options: CreateMapperOptions): Mapper {
  return createMapperOver(
    options.documents === undefined
      ? mappingDocuments(options.environment)
      : // Array.from visits a hole, so a sparse array is refused rather than skipped
        Array.from(options.documents, (document, i) =>
          parseMappingDocument(document, `documents[${i}]`),
        ),
  );
}
