/**
 * The one error this package throws: a mapping document that does not admit
 * (`parseMappingDocument`), or a set of admitted documents that forms no mapper: none, two
 * environments, or two documents for one program (`createMapper`). Mapping itself never
 * throws; it returns a result.
 */
export class MappingDocumentError extends Error {
  override readonly name = "MappingDocumentError";

  constructor(
    /** Which document, or part of one, the message is about. */
    readonly at: string,
    message: string,
  ) {
    super(`${at}: ${message}`);
  }
}
