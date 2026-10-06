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
  type MappedInstruction,
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

/**
 * A patch that drops the account index a client may leave out, and its position, and puts a
 * supplied account at account index 4 in its place, with `fields` over the defaults.
 */
function suppliedAt4(
  fields: Record<string, unknown> = {},
): (document: Record<string, unknown>) => void {
  return (d) => {
    (entry(d).destination_accounts as unknown[]).pop();
    (entry(d).source_accounts as unknown[]).pop();
    (entry(d).destination_accounts as unknown[]).push({
      index: 4,
      kind: "supplied",
      role: "bridge_routes",
      writable: false,
      signer: false,
      ...fields,
    });
  };
}

/** The supplied account at account index 4, derived under the proxy program from `values`. */
function seeds(
  ...values: unknown[]
): (document: Record<string, unknown>) => void {
  return suppliedAt4({ derivation: { program: PROXY, seeds: values } });
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
    assert.equal(
      (mapped as { supplied_accounts?: unknown }).supplied_accounts,
      undefined,
    );
  });

  it("admits supplied accounts and reads them as written", () => {
    const document = parseMappingDocument(
      withPatch((d) => {
        // without the seat a client may leave out, and its position
        (entry(d).destination_accounts as unknown[]).pop();
        (entry(d).source_accounts as unknown[]).pop();
        entry(d).supplied_accounts = [
          { role: "asset_oracle", of: [1] },
          { role: "asset_oracle", of: [0, 1] },
          { role: "sol_usd_oracle", optional: true },
        ];
      }),
    );
    // the same position may serve two roles
    assert.deepEqual(
      (document.instructions[0] as { supplied_accounts?: unknown })
        .supplied_accounts,
      [
        { role: "asset_oracle", of: [1] },
        { role: "asset_oracle", of: [0, 1] },
        { role: "sol_usd_oracle", optional: true },
      ],
    );
  });

  it("admits supplied accounts at their account indexes and reads them as written", () => {
    const input = withPatch((d) => {
      seeds(
        // the longest constant a seed may be
        { kind: "const", value: Array.from({ length: 32 }, (_, i) => i) },
        { kind: "account", index: 0 },
        { kind: "account", index: 1 },
        { kind: "account", index: 2 },
        // a program-id optional: the mapper places an account there either way
        { kind: "account", index: 3 },
        { kind: "arg", path: "params.protocol" },
      )(d);
      (entry(d).destination_accounts as unknown[]).push(
        {
          index: 5,
          kind: "supplied",
          role: "strategy_market",
          writable: true,
          signer: false,
        },
        // a derivation may state no seeds
        {
          index: 6,
          kind: "supplied",
          role: "registry",
          writable: false,
          signer: false,
          derivation: { program: PROXY, seeds: [] },
        },
      );
    });
    const document = parseMappingDocument(input);
    assert.deepEqual(document, input);
    // one the IDL states no derivation for carries none
    const mapped = document.instructions[0] as MappedInstruction;
    assert.equal("derivation" in mapped.destination_accounts[5]!, false);
    // and what the parser reads admits again as it is
    assert.deepEqual(
      parseMappingDocument(JSON.parse(JSON.stringify(document))),
      document,
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
    [
      "supplied accounts on a passthrough",
      (d) => (entry(d, 1).supplied_accounts = []),
      'a passthrough entry carries no "supplied_accounts"',
    ],
    [
      "supplied accounts on an unsupported entry",
      (d) => (entry(d, 2).supplied_accounts = []),
      'a unsupported entry carries no "supplied_accounts"',
    ],
    [
      "supplied accounts that are not an array",
      (d) => (entry(d).supplied_accounts = 5),
      "supplied_accounts must be an array",
    ],
    [
      "a supplied account that is not an object",
      (d) => (entry(d).supplied_accounts = [5]),
      "supplied_accounts[0]: must be an object",
    ],
    [
      "a null supplied account",
      (d) => (entry(d).supplied_accounts = [null]),
      "supplied_accounts[0]: must be an object",
    ],
    [
      "a supplied account without a role",
      (d) => (entry(d).supplied_accounts = [{ of: [1] }]),
      "supplied_accounts[0]: role must be a non-blank string",
    ],
    [
      "a second supplied account without a role",
      (d) => (entry(d).supplied_accounts = [{ role: "a" }, { of: [1] }]),
      "supplied_accounts[1]: role must be a non-blank string",
    ],
    [
      "a supplied account with a blank role",
      (d) => (entry(d).supplied_accounts = [{ role: " " }]),
      "role must be a non-blank string",
    ],
    [
      "a supplied account with an unknown field",
      (d) => (entry(d).supplied_accounts = [{ role: "r", x: 1 }]),
      'unknown field "x"',
    ],
    [
      "a supplied account whose of is not an array",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: 5 }]),
      "of must be an array",
    ],
    [
      "a supplied account whose of holds a string",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: ["x"] }]),
      "of[0] must be a non-negative integer",
    ],
    [
      "a supplied account whose of holds a negative",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [-1] }]),
      "of[0] must be a non-negative integer",
    ],
    [
      "a supplied account whose of holds a fraction",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [1.5] }]),
      "of[0] must be a non-negative integer",
    ],
    [
      "a supplied account naming the position just past the list",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [4] }]),
      "supplied_accounts[0] names source position 4, which is out of range of 4",
    ],
    [
      "a supplied account naming a position out of range",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [9] }]),
      "supplied_accounts[0] names source position 9, which is out of range of 4",
    ],
    [
      "a supplied account naming an omittable position",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [3] }]),
      "supplied_accounts[0] names source position 3, which a client may leave out; an absent run would shift it",
    ],
    [
      "a supplied account naming a position a client may pass as the program id",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [2] }]),
      "supplied_accounts[0] names source position 2, which a client may pass as the program id; an absent optional names no account",
    ],
    [
      "a supplied account with a role that is not a string",
      (d) => (entry(d).supplied_accounts = [{ role: 5 }]),
      "role must be a non-blank string",
    ],
    [
      "a supplied account with two unknown fields",
      (d) => (entry(d).supplied_accounts = [{ role: "r", aaa: 1, bbb: 2 }]),
      'unknown field "aaa"',
    ],
    [
      "a second bad of position",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: [1, "x"] }]),
      "of[1] must be a non-negative integer",
    ],
    [
      "two bad of positions name the first",
      (d) => (entry(d).supplied_accounts = [{ role: "r", of: ["x", "y"] }]),
      "of[0] must be a non-negative integer",
    ],
    [
      "a supplied account whose optional is not a boolean",
      (d) => (entry(d).supplied_accounts = [{ role: "a", optional: "yes" }]),
      "optional must be true when present",
    ],
    [
      "a bad element ahead of a shape fault: the element is named first",
      (d) =>
        (entry(d).supplied_accounts = [
          { role: "a", optional: true },
          { role: "b", of: ["x"] },
        ]),
      "supplied_accounts[1]: of[0] must be a non-negative integer",
    ],
    [
      "a required supplied account after an optional one",
      (d) =>
        (entry(d).supplied_accounts = [
          { role: "a", optional: true },
          { role: "b" },
        ]),
      "supplied_accounts[1] is required after an optional one; optional accounts trail",
    ],
    [
      "supplied accounts on an entry with a seat a client may leave out",
      (d) => (entry(d).supplied_accounts = [{ role: "r" }]),
      "supplied_accounts follow seat 4, which a client may leave out; an absent one would shift them",
    ],
    [
      "a supplied account whose optional is false",
      (d) => (entry(d).supplied_accounts = [{ role: "a", optional: false }]),
      "optional must be true when present",
    ],
    [
      "a supplied account whose optional is the string true",
      (d) => (entry(d).supplied_accounts = [{ role: "a", optional: "true" }]),
      "optional must be true when present",
    ],
    [
      "a supplied account at an account index without a role",
      suppliedAt4({ role: undefined }),
      "destination_accounts[4]: role must be a non-blank string",
    ],
    [
      "a supplied account at an account index with a blank role",
      suppliedAt4({ role: " " }),
      "destination_accounts[4]: role must be a non-blank string",
    ],
    [
      "a supplied account at an account index carrying a name",
      suppliedAt4({ name: "glam_state" }),
      'destination_accounts[4]: a supplied account carries no "name"',
    ],
    [
      "a supplied account at an account index carrying an address",
      suppliedAt4({ address: PROXY }),
      'destination_accounts[4]: a supplied account carries no "address"',
    ],
    [
      "a supplied account at an account index carrying a source",
      suppliedAt4({ source: 0 }),
      'destination_accounts[4]: a supplied account carries no "source"',
    ],
    [
      "a supplied account at an account index carrying a sentinel",
      suppliedAt4({ sentinel: true }),
      'destination_accounts[4]: a supplied account carries no "sentinel"',
    ],
    [
      "a supplied account at an account index carrying of",
      suppliedAt4({ of: [0] }),
      'destination_accounts[4]: unknown field "of"',
    ],
    [
      "a supplied account at an account index carrying optional",
      suppliedAt4({ optional: true }),
      'destination_accounts[4]: unknown field "optional"',
    ],
    [
      "a dynamic account carrying a role",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[0]!.role =
          "r"),
      'destination_accounts[0]: a dynamic seat carries no "role"',
    ],
    [
      "a dynamic account carrying a derivation",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[0]!.derivation = { program: PROXY, seeds: [] }),
      'destination_accounts[0]: a dynamic seat carries no "derivation"',
    ],
    [
      "a static account carrying a role",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[1]!.role =
          "r"),
      'destination_accounts[1]: a static seat carries no "role"',
    ],
    [
      "a static account carrying a derivation",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!.derivation = { program: PROXY, seeds: [] }),
      'destination_accounts[1]: a static seat carries no "derivation"',
    ],
    [
      "a forwarded account carrying a role",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[2]!.role =
          "r"),
      'destination_accounts[2]: a source seat carries no "role"',
    ],
    [
      "a forwarded account carrying a derivation",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!.derivation = { program: PROXY, seeds: [] }),
      'destination_accounts[2]: a source seat carries no "derivation"',
    ],
    [
      "a forwarded account carrying a malformed derivation",
      (d) =>
        ((
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!.derivation = 5),
      'destination_accounts[2]: a source seat carries no "derivation"',
    ],
    [
      "a dynamic account carrying a sentinel and a role: the sentinel is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[0]!;
        seat.sentinel = true;
        seat.role = "r";
      },
      'destination_accounts[0]: a dynamic seat carries no "sentinel"',
    ],
    [
      "a forwarded account carrying a role and a negative source: the role is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!;
        seat.role = "r";
        seat.source = -1;
      },
      'destination_accounts[2]: a source seat carries no "role"',
    ],
    [
      "a dynamic account carrying a role and a derivation: the role is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[0]!;
        seat.role = "r";
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[0]: a dynamic seat carries no "role"',
    ],
    [
      "a static account carrying a name and a role: the name is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!;
        seat.name = "glam_vault";
        seat.role = "r";
      },
      'destination_accounts[1]: a static seat carries no "name"',
    ],
    [
      "a static account carrying a role and a derivation: the role is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!;
        seat.role = "r";
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[1]: a static seat carries no "role"',
    ],
    [
      "a forwarded account carrying a name and a role: the name is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!;
        seat.name = "thing";
        seat.role = "r";
      },
      'destination_accounts[2]: a source seat carries no "name"',
    ],
    [
      "a forwarded account carrying an address and a derivation: the address is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!;
        seat.address = PROXY;
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[2]: a source seat carries no "address"',
    ],
    [
      "a supplied account at an account index carrying a name and a source: the name is named",
      suppliedAt4({ name: "glam_state", source: 0 }),
      'destination_accounts[4]: a supplied account carries no "name"',
    ],
    [
      "a supplied account at an account index carrying a source and a sentinel: the source is named",
      suppliedAt4({ source: 0, sentinel: true }),
      'destination_accounts[4]: a supplied account carries no "source"',
    ],
    [
      "a static account carrying a sentinel and a role: the sentinel is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!;
        seat.sentinel = true;
        seat.role = "r";
      },
      'destination_accounts[1]: a static seat carries no "sentinel"',
    ],
    [
      "a forwarded account carrying an address and a role: the address is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!;
        seat.address = PROXY;
        seat.role = "r";
      },
      'destination_accounts[2]: a source seat carries no "address"',
    ],
    [
      "a forwarded account carrying a role and a derivation: the role is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!;
        seat.role = "r";
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[2]: a source seat carries no "role"',
    ],
    [
      "a dynamic account carrying a derivation and no name: the derivation is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[0]!;
        delete seat.name;
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[0]: a dynamic seat carries no "derivation"',
    ],
    [
      "a static account carrying a derivation and a malformed address: the derivation is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[1]!;
        seat.address = "not an address";
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[1]: a static seat carries no "derivation"',
    ],
    [
      "a forwarded account carrying a derivation and a negative source: the derivation is named",
      (d) => {
        const seat = (
          entry(d).destination_accounts as Record<string, unknown>[]
        )[2]!;
        seat.source = -1;
        seat.derivation = { program: PROXY, seeds: [] };
      },
      'destination_accounts[2]: a source seat carries no "derivation"',
    ],
    [
      "a supplied account at an account index carrying a name and an address: the name is named",
      suppliedAt4({ name: "glam_state", address: PROXY }),
      'destination_accounts[4]: a supplied account carries no "name"',
    ],
    [
      "a supplied account at an account index carrying an address and a source: the address is named",
      suppliedAt4({ address: PROXY, source: 0 }),
      'destination_accounts[4]: a supplied account carries no "address"',
    ],
    [
      "a supplied account at an account index carrying a sentinel and a blank role: the sentinel is named",
      suppliedAt4({ sentinel: true, role: " " }),
      'destination_accounts[4]: a supplied account carries no "sentinel"',
    ],
    [
      "a supplied account at an account index carrying a blank role and a malformed derivation: the role is named",
      suppliedAt4({ role: " ", derivation: 5 }),
      "destination_accounts[4]: role must be a non-blank string",
    ],
    [
      "a derivation that is an array",
      suppliedAt4({ derivation: [] }),
      "destination_accounts[4]: derivation must be an object",
    ],
    [
      "a null derivation",
      suppliedAt4({ derivation: null }),
      "destination_accounts[4]: derivation must be an object",
    ],
    [
      "a derivation that is a number",
      suppliedAt4({ derivation: 5 }),
      "destination_accounts[4]: derivation must be an object",
    ],
    [
      "a derivation with an unknown field",
      suppliedAt4({ derivation: { program: PROXY, seeds: [], bump: 255 } }),
      'destination_accounts[4] derivation: unknown field "bump"',
    ],
    [
      "a derivation without a program",
      suppliedAt4({ derivation: { seeds: [] } }),
      "destination_accounts[4] derivation: program must be a non-blank string",
    ],
    [
      "a derivation whose program is not an address",
      suppliedAt4({ derivation: { program: "short", seeds: [] } }),
      "destination_accounts[4] derivation: program is not an address",
    ],
    [
      "a derivation without seeds",
      suppliedAt4({ derivation: { program: PROXY } }),
      "destination_accounts[4] derivation: seeds must be an array",
    ],
    [
      "a hole in the seeds",
      suppliedAt4({ derivation: { program: PROXY, seeds: new Array(1) } }),
      "destination_accounts[4] derivation: seeds[0] is missing",
    ],
    [
      "a seed that is not an object",
      seeds(5),
      "destination_accounts[4] derivation seeds[0]: must be an object",
    ],
    [
      "a seed without a kind",
      seeds({ value: [1] }),
      "derivation seeds[0]: the seed has no kind",
    ],
    [
      "an unknown seed kind",
      seeds({ kind: "pda", value: [1] }),
      "derivation seeds[0]: unknown seed kind pda",
    ],
    [
      "a seed with an unknown field",
      seeds({ kind: "const", value: [1], bump: 255 }),
      'derivation seeds[0]: unknown field "bump"',
    ],
    [
      "a const seed without a value",
      seeds({ kind: "const" }),
      "derivation seeds[0]: value must be an array",
    ],
    [
      "a const seed holding a value that is not a byte",
      seeds({ kind: "const", value: [1, 256] }),
      "derivation seeds[0]: value[1] is not a byte",
    ],
    [
      "a const seed carrying an index",
      seeds({ kind: "const", value: [1], index: 0 }),
      'derivation seeds[0]: a const seed carries no "index"',
    ],
    [
      "a const seed carrying a path",
      seeds({ kind: "const", value: [1], path: "p" }),
      'derivation seeds[0]: a const seed carries no "path"',
    ],
    [
      "a const seed carrying an index and a path: the index is named",
      seeds({ kind: "const", value: [1], index: 0, path: "p" }),
      'derivation seeds[0]: a const seed carries no "index"',
    ],
    [
      "an account seed without an index",
      seeds({ kind: "account" }),
      "derivation seeds[0]: index must be a non-negative integer",
    ],
    [
      "an account seed with a negative index",
      seeds({ kind: "account", index: -1 }),
      "derivation seeds[0]: index must be a non-negative integer",
    ],
    [
      "an account seed carrying a value",
      seeds({ kind: "account", index: 0, value: [1] }),
      'derivation seeds[0]: an account seed carries no "value"',
    ],
    [
      "an account seed carrying a path",
      seeds({ kind: "account", index: 0, path: "p" }),
      'derivation seeds[0]: an account seed carries no "path"',
    ],
    [
      "an arg seed without a path",
      seeds({ kind: "arg" }),
      "derivation seeds[0]: path must be a non-blank string",
    ],
    [
      "an arg seed with a blank path",
      seeds({ kind: "arg", path: " " }),
      "derivation seeds[0]: path must be a non-blank string",
    ],
    [
      "an arg seed carrying a value",
      seeds({ kind: "arg", path: "p", value: [1] }),
      'derivation seeds[0]: an arg seed carries no "value"',
    ],
    [
      "an arg seed carrying an index",
      seeds({ kind: "arg", path: "p", index: 0 }),
      'derivation seeds[0]: an arg seed carries no "index"',
    ],
    [
      "a second bad seed: the seed is named by its position",
      seeds({ kind: "const", value: [1] }, { kind: "arg" }),
      "derivation seeds[1]: path must be a non-blank string",
    ],
    [
      "a supplied account at an account index that signs",
      suppliedAt4({ signer: true }),
      "the supplied account at account index 4 signs; a supplied account never signs",
    ],
    [
      "a derivation naming the account index just past the list",
      seeds({ kind: "account", index: 5 }),
      "the supplied account at account index 4 derives from account index 5, which is out of range of 5",
    ],
    [
      "a derivation naming its own account index",
      seeds({ kind: "account", index: 4 }),
      "the supplied account at account index 4 derives from account index 4, which the context supplies; a mapper resolves no supplied account for another",
    ],
    [
      "a derivation naming another supplied account",
      (d) => {
        seeds({ kind: "account", index: 1 })(d);
        (entry(d).destination_accounts as Record<string, unknown>[])[1] = {
          index: 1,
          kind: "supplied",
          role: "strategy_market",
          writable: false,
          signer: false,
        };
      },
      "the supplied account at account index 4 derives from account index 1, which the context supplies; a mapper resolves no supplied account for another",
    ],
    [
      "a derivation naming another supplied account, the accounts listed out of account-index order",
      (d) => {
        seeds({ kind: "account", index: 1 })(d);
        (entry(d).destination_accounts as Record<string, unknown>[])[1] = {
          index: 1,
          kind: "supplied",
          role: "strategy_market",
          writable: false,
          signer: false,
        };
        // reversed: list position 1 holds the forwarded account at account index 3
        (entry(d).destination_accounts as unknown[]).reverse();
      },
      "the supplied account at account index 4 derives from account index 1, which the context supplies; a mapper resolves no supplied account for another",
    ],
    [
      "a derivation naming an account index a client may leave out",
      (d) =>
        ((entry(d).destination_accounts as Record<string, unknown>[])[1] = {
          index: 1,
          kind: "supplied",
          role: "bridge_routes",
          writable: false,
          signer: false,
          derivation: {
            program: PROXY,
            seeds: [{ kind: "account", index: 4 }],
          },
        }),
      "the supplied account at account index 1 derives from account index 4, which a client may leave out",
    ],
    [
      "a constant seed longer than 32 bytes",
      seeds(
        { kind: "const", value: [1] },
        { kind: "const", value: new Array<number>(33).fill(1) },
      ),
      "the supplied account at account index 4 has a constant seed longer than 32 bytes",
    ],
    [
      "a supplied account at an account index after one a client may leave out",
      (d) =>
        (entry(d).destination_accounts as unknown[]).push({
          index: 5,
          kind: "supplied",
          role: "bridge_routes",
          writable: false,
          signer: false,
        }),
      "seat 5 follows a seat a client may leave out; an absent one would shift it",
    ],
    [
      "a supplied account at an account index that signs, before its derivation",
      suppliedAt4({
        signer: true,
        derivation: { program: PROXY, seeds: [{ kind: "account", index: 9 }] },
      }),
      "the supplied account at account index 4 signs; a supplied account never signs",
    ],
    [
      "a gap in the account indexes, before a derivation",
      (d) => {
        seeds({ kind: "account", index: 9 })(d);
        (entry(d).destination_accounts as Record<string, unknown>[])[4]!.index =
          7;
      },
      "seats are not dense from 0: seat 7 of 5",
    ],
    [
      "a supplied account at an account index that signs, before the derivation of another listed ahead of it",
      (d) => {
        suppliedAt4({ signer: true })(d);
        (entry(d).destination_accounts as Record<string, unknown>[])[1] = {
          index: 1,
          kind: "supplied",
          role: "strategy_market",
          writable: false,
          signer: false,
          derivation: {
            program: PROXY,
            seeds: [{ kind: "account", index: 9 }],
          },
        };
      },
      "the supplied account at account index 4 signs; a supplied account never signs",
    ],
    [
      "an account seed outside the list, before a later constant seed longer than 32 bytes",
      seeds(
        { kind: "account", index: 9 },
        { kind: "const", value: new Array<number>(33).fill(1) },
      ),
      "the supplied account at account index 4 derives from account index 9, which is out of range of 5",
    ],
    [
      "a constant seed longer than 32 bytes, before a later account seed outside the list",
      seeds(
        { kind: "const", value: new Array<number>(33).fill(1) },
        { kind: "account", index: 9 },
      ),
      "the supplied account at account index 4 has a constant seed longer than 32 bytes",
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
