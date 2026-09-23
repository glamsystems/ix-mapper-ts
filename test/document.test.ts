import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MappingDocumentError,
  mappingDocuments,
  parseMappingDocument,
  SCHEMA_VERSION,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mappingDir = path.join(here, "..", "src", "generated", "mapping");

function readDocuments(
  environment: "production" | "staging",
): { name: string; value: unknown }[] {
  const dir = path.join(mappingDir, environment);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      value: JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8"),
      ) as unknown,
    }));
}

describe("the bundled documents", () => {
  for (const environment of ["production", "staging"] as const) {
    it(`${environment}: every file admits, is named for its program, and is what the package bundles`, () => {
      const files = readDocuments(environment);
      assert.ok(files.length > 0);
      const bundled = mappingDocuments(environment);
      assert.equal(bundled.length, files.length);
      for (const [i, file] of files.entries()) {
        const document = parseMappingDocument(file.value, file.name);
        assert.equal(document.environment, environment);
        assert.equal(file.name, `${document.program_id}.json`);
        assert.deepEqual(bundled[i], document);
      }
      assert.equal(
        new Set(bundled.map((document) => document.program_id)).size,
        bundled.length,
      );
    });
  }
});

const PROGRAM = "Src1111111111111111111111111111111111111111";
const PROXY = "Proxy11111111111111111111111111111111111111";

function valid(): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    environment: "test",
    program_id: PROGRAM,
    proxy_program_id: PROXY,
    provenance: { generator: "g", config_revision: 1 },
    instructions: [
      {
        name: "do",
        discriminator: [1, 2],
        disposition: "map",
        handler: { name: "proxy_do", discriminator: [9] },
        source_accounts: [
          { name: "owner", writable: true, signer: true, expect: "glam_vault" },
          { name: "thing", writable: true, signer: false },
          {
            name: "maybe",
            writable: false,
            signer: false,
            optional: "program_id",
          },
          {
            name: "trailing",
            writable: false,
            signer: false,
            optional: "omitted",
          },
        ],
        destination_accounts: [
          {
            index: 0,
            kind: "dynamic",
            name: "glam_vault",
            writable: true,
            signer: false,
          },
          {
            index: 1,
            kind: "static",
            address: PROXY,
            writable: false,
            signer: false,
          },
          {
            index: 2,
            kind: "source",
            source: 1,
            writable: true,
            signer: false,
          },
          {
            index: 3,
            kind: "source",
            source: 2,
            writable: false,
            signer: false,
            sentinel: true,
          },
          {
            index: 4,
            kind: "source",
            source: 3,
            writable: false,
            signer: false,
          },
        ],
        remaining_accounts: { kind: "any" },
      },
      {
        name: "read",
        discriminator: [3],
        disposition: "passthrough",
        reason: "nothing signs",
      },
      {
        name: "other",
        discriminator: [4],
        disposition: "unsupported",
        reason: "no handler",
      },
    ],
  };
}

function withPatch(
  patch: (document: Record<string, unknown>) => void,
): unknown {
  const document = valid();
  patch(document);
  return document;
}

function entry(
  document: Record<string, unknown>,
  i = 0,
): Record<string, unknown> {
  return (document.instructions as Record<string, unknown>[])[i]!;
}

describe("parseMappingDocument", () => {
  it("admits a valid document and reads its defaults", () => {
    const document = parseMappingDocument(valid());
    assert.equal(document.instructions.length, 3);
    const mapped = document.instructions[0]!;
    assert.equal(mapped.disposition, "map");
    const minimal = parseMappingDocument(
      withPatch((d) => {
        delete d.provenance;
        delete (entry(d) as Record<string, unknown>).remaining_accounts;
      }),
    );
    assert.equal(minimal.provenance, undefined);
    const revisionless = parseMappingDocument(
      withPatch(
        (d) => delete (d.provenance as Record<string, unknown>).config_revision,
      ),
    );
    assert.equal(revisionless.provenance?.config_revision, 1);
    assert.deepEqual(
      (minimal.instructions[0] as { remaining_accounts: unknown })
        .remaining_accounts,
      { kind: "any" },
    );
  });

  const refusals: [
    string,
    (document: Record<string, unknown>) => void,
    string,
  ][] = [
    [
      "another schema version",
      (d) => (d.schema_version = 2),
      "schema_version 2 is not 1",
    ],
    [
      "an unknown top-level field",
      (d) => (d.index_map = []),
      'unknown field "index_map"',
    ],
    [
      "a blank environment",
      (d) => (d.environment = " "),
      "environment must be a non-blank string",
    ],
    [
      "a program id that is not an address",
      (d) => (d.program_id = "short"),
      "program_id is not an address",
    ],
    [
      "an unknown provenance field",
      (d) => ((d.provenance as Record<string, unknown>).commit = "x"),
      'unknown field "commit"',
    ],
    [
      "a zero config revision",
      (d) => ((d.provenance as Record<string, unknown>).config_revision = 0),
      "config_revision must be a positive integer",
    ],
    [
      "an entry without a disposition",
      (d) => delete entry(d, 1).disposition,
      "read has no disposition",
    ],
    [
      "an unknown disposition",
      (d) => (entry(d, 1).disposition = "relay"),
      "unknown disposition relay",
    ],
    [
      "a passthrough without a reason",
      (d) => (entry(d, 1).reason = ""),
      "reason must be a non-blank string",
    ],
    [
      "a passthrough carrying seats",
      (d) => (entry(d, 1).destination_accounts = []),
      'a passthrough entry carries no "destination_accounts"',
    ],
    [
      "a map entry carrying a reason",
      (d) => (entry(d).reason = "r"),
      'a map entry carries no "reason"',
    ],
    [
      "an empty discriminator",
      (d) => (entry(d, 2).discriminator = []),
      "other has no discriminator",
    ],
    [
      "a byte out of range",
      (d) => (entry(d, 2).discriminator = [256]),
      "discriminator[0] is not a byte",
    ],
    [
      "a discriminator another's prefixes",
      (d) => (entry(d, 2).discriminator = [1]),
      "discriminator of other ([1]) is a prefix of do's",
    ],
    [
      "a discriminator that prefixes a later one",
      (d) => (entry(d, 2).discriminator = [1, 2, 3]),
      "discriminator of do ([1, 2]) is a prefix of other's",
    ],
    [
      "two equal discriminators",
      (d) => (entry(d, 2).discriminator = [1, 2]),
      "discriminator of do ([1, 2]) is a prefix of other's",
    ],
    [
      "a null config revision",
      (d) => ((d.provenance as Record<string, unknown>).config_revision = null),
      "config_revision must be a non-negative integer",
    ],
    [
      "a proxy program id that is not an address",
      (d) => (d.proxy_program_id = "short"),
      "proxy_program_id is not an address",
    ],
    [
      "an address outside the base58 alphabet",
      (d) => (d.proxy_program_id = "0".repeat(32)),
      "proxy_program_id is not an address",
    ],
    [
      "an address longer than 44 characters",
      (d) => (d.program_id = "1".repeat(45)),
      "program_id is not an address",
    ],
    [
      "a static seat outside the base58 alphabet",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!.address = "O".repeat(40)),
      "address is not an address",
    ],
    [
      "a negative byte",
      (d) => (entry(d, 2).discriminator = [-1]),
      "discriminator[0] is not a byte",
    ],
    [
      "a hole in a discriminator",
      (d) =>
        ((entry(d).handler as Record<string, unknown>).discriminator =
          new Array(1)),
      "discriminator[0] is missing",
    ],
    [
      "a handler without a discriminator",
      (d) => (entry(d).handler = { name: "proxy_do", discriminator: [] }),
      "the handler has no discriminator",
    ],
    [
      "a passthrough carrying a handler",
      (d) => (entry(d, 1).handler = { name: "h", discriminator: [1] }),
      'a passthrough entry carries no "handler"',
    ],
    [
      "a dynamic seat carrying a sentinel",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[0]!.sentinel = true),
      'a dynamic seat carries no "sentinel"',
    ],
    [
      "a source seat carrying a name",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[2]!.name =
          "thing"),
      'a source seat carries no "name"',
    ],
    [
      "a sentinel that is false",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[3]!.sentinel = false),
      "sentinel must be true when present",
    ],
    [
      "a sentinel on an omitted position",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[4]!.sentinel = true),
      "seat 4 rewrites a sentinel, but source position 3 is not an optional the client passes as the program id",
    ],
    [
      "a forwarded seat read-only over a writable position",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!.writable = false),
      "seat 2 forwards source position 1 read-only, which the native instruction declares writable",
    ],
    [
      "a seat index listed twice",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[4]!.index = 3),
      "seat 3 is listed twice",
    ],
    [
      "a source position out of range",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[4]!.source = 9),
      "seat 4 forwards source position 9, which is out of range of 4",
    ],
    [
      "an unknown source field",
      (d) =>
        ((entry(d).source_accounts as Record<string, unknown>[])[0]!.index = 0),
      'unknown field "index"',
    ],
    [
      "an unknown optional kind",
      (d) =>
        ((entry(d).source_accounts as Record<string, unknown>[])[2]!.optional =
          "maybe"),
      "unknown optional kind maybe",
    ],
    [
      "a short expectation",
      (d) =>
        ((entry(d).source_accounts as Record<string, unknown>[])[0]!.expect =
          "vault"),
      "neither a dynamic account nor an address",
    ],
    [
      "a dynamic_signer that is false",
      (d) =>
        ((
          entry(d).source_accounts as Record<string, unknown>[]
        )[1]!.dynamic_signer = false),
      "dynamic_signer must be true when present",
    ],
    [
      "a seat without a kind",
      (d) =>
        delete (entry(d).destination_accounts as Record<string, unknown>[])[0]!
          .kind,
      "the seat has no kind",
    ],
    [
      "an unknown seat kind",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[0]!.kind =
          "fixed"),
      "unknown seat kind fixed",
    ],
    [
      "an unknown dynamic account",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[0]!.name =
          "glam_treasury"),
      "unknown dynamic account glam_treasury",
    ],
    [
      "a static seat with a source",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!.source = 0),
      'a static seat carries no "source"',
    ],
    [
      "a gap in the seats",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[4]!.index = 7),
      "seats are not dense from 0",
    ],
    [
      "a position forwarded twice",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[4]!.source = 1),
      "already forwarded",
    ],
    [
      "a sentinel on a required position",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!.sentinel = true),
      "rewrites a sentinel",
    ],
    [
      "an omittable optional ahead of a required position",
      (d) =>
        ((entry(d).source_accounts as Record<string, unknown>[])[1]!.optional =
          "omitted"),
      "follows an omittable optional",
    ],
    [
      "a seat after an omittable seat",
      (d) => {
        const seats = entry(d).destination_accounts as Record<
          string,
          unknown
        >[];
        seats[4]!.index = 2;
        seats[2]!.index = 4;
      },
      "follows a seat a client may leave out",
    ],
    [
      "an unknown remaining-accounts kind",
      (d) => (entry(d).remaining_accounts = { kind: "segment" }),
      "unknown remaining-accounts kind segment",
    ],
    [
      "a hole in the instructions",
      (d) => (d.instructions = new Array(1)),
      "instructions[0] is missing",
    ],
    [
      "a hole in the source accounts",
      (d) => (entry(d).source_accounts = new Array(1)),
      "source_accounts[0] is missing",
    ],
    [
      "omittable seats out of source order",
      (d) => {
        const sources = entry(d).source_accounts as Record<string, unknown>[];
        sources[2]!.optional = "omitted";
        const seats = entry(d).destination_accounts as Record<
          string,
          unknown
        >[];
        delete seats[3]!.sentinel;
        seats[3]!.index = 4;
        seats[4]!.index = 3;
      },
      "forwards omittable position 2 after position 3",
    ],
  ];
  for (const [what, patch, message] of refusals) {
    it(`refuses ${what}`, () => {
      assert.throws(
        () => parseMappingDocument(withPatch(patch)),
        (error: unknown) =>
          error instanceof MappingDocumentError &&
          error.message.includes(message),
        `expected a refusal mentioning: ${message}`,
      );
    });
  }
});
