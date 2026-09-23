import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  createMapper,
  MappingDocumentError,
  type MappingContext,
  type MapResult,
  type NeutralInstruction,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, "data", "cases");

interface Case {
  readonly name: string;
  readonly note: string;
  readonly environment: "production" | "staging" | null;
  readonly documents?: unknown[];
  readonly instruction: {
    programAddress: string;
    accounts: { address: string; writable: boolean; signer: boolean }[];
    data: number[];
  };
  readonly context: {
    glamState: string;
    glamVault: string;
    glamSigner: string;
    integrationAuthority?: true;
  };
  readonly expected: Record<string, unknown>;
}

const STATE = "State1111111111111111111111111111111111111";
const VAULT = "Vau1t1111111111111111111111111111111111111";
const SIGNER = "Signer111111111111111111111111111111111111";
const PROGRAM = "Src1111111111111111111111111111111111111111";
const PROXY = "Proxy11111111111111111111111111111111111111";
const context = { glamState: STATE, glamVault: VAULT, glamSigner: SIGNER };

/** The oracle names an integration authority by the proxy program it belongs to. */
function authorityOf(proxyProgram: string): string {
  return `Auth${proxyProgram.slice(4)}`.slice(0, 44);
}

function toInstruction(value: Case["instruction"]): NeutralInstruction {
  return {
    programAddress: value.programAddress,
    accounts: value.accounts,
    data: Uint8Array.from(value.data),
  };
}

function toComparable(result: MapResult): Record<string, unknown> {
  if (result.kind === "unsupported") return { ...result };
  return {
    ...result,
    instruction: {
      ...result.instruction,
      data: Array.from(result.instruction.data),
    },
  };
}

describe("the mapping cases", () => {
  const files = fs
    .readdirSync(casesDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.ok(files.length > 0);
  for (const file of files) {
    const testCase = JSON.parse(
      fs.readFileSync(path.join(casesDir, file), "utf8"),
    ) as Case;
    it(`${testCase.name}: ${testCase.note}`, () => {
      // a case's own documents go in as parsed JSON: createMapper admits them
      const mapper =
        testCase.environment === null
          ? createMapper({ documents: testCase.documents ?? [] })
          : createMapper({ environment: testCase.environment });
      const context: MappingContext = {
        glamState: testCase.context.glamState,
        glamVault: testCase.context.glamVault,
        glamSigner: testCase.context.glamSigner,
        ...(testCase.context.integrationAuthority
          ? { integrationAuthority: authorityOf }
          : {}),
      };
      const result = mapper.map(toInstruction(testCase.instruction), context);
      assert.deepEqual(toComparable(result), testCase.expected);
    });
  }
});

/** A document of one mapped entry that forwards its position and every account beyond it. */
function relaying(): unknown {
  return {
    schema_version: 1,
    environment: "test",
    program_id: PROGRAM,
    proxy_program_id: PROXY,
    instructions: [
      {
        name: "relay",
        discriminator: [1],
        disposition: "map",
        handler: {
          name: "proxy_relay",
          discriminator: [9, 9, 9, 9, 9, 9, 9, 9],
        },
        source_accounts: [{ name: "thing", writable: true, signer: false }],
        destination_accounts: [
          {
            index: 0,
            kind: "dynamic",
            name: "glam_state",
            writable: false,
            signer: false,
          },
          {
            index: 1,
            kind: "source",
            source: 0,
            writable: true,
            signer: false,
          },
        ],
        remaining_accounts: { kind: "any" },
      },
    ],
  };
}

/** A document of one mapped entry that expects the integration authority at position 0. */
function expectingAuthority(): unknown {
  return {
    schema_version: 1,
    environment: "test",
    program_id: PROGRAM,
    proxy_program_id: PROXY,
    instructions: [
      {
        name: "do",
        discriminator: [1],
        disposition: "map",
        handler: { name: "proxy_do", discriminator: [9] },
        source_accounts: [
          {
            name: "authority",
            writable: false,
            signer: false,
            expect: "integration_authority",
          },
        ],
        destination_accounts: [
          {
            index: 0,
            kind: "dynamic",
            name: "glam_state",
            writable: false,
            signer: false,
          },
        ],
      },
    ],
  };
}

describe("createMapper", () => {
  it("holds one environment and one document per program", () => {
    const production = createMapper({ environment: "production" });
    assert.equal(production.environment, "production");
    assert.ok(production.documentOf("11111111111111111111111111111111"));
    assert.equal(
      production.documentOf("ComputeBudget111111111111111111111111111111"),
      undefined,
    );
    const staging = createMapper({ environment: "staging" });
    assert.equal(staging.environment, "staging");
    assert.throws(
      () => createMapper({ documents: [] }),
      /at least one mapping document/,
    );
    assert.throws(
      () =>
        createMapper({
          documents: [...production.documents, ...staging.documents],
        }),
      /declares environment staging; the mapper's is production/,
    );
    assert.throws(
      () =>
        createMapper({
          documents: [production.documents[0]!, production.documents[0]!],
        }),
      /two documents for one program/,
    );
  });

  it("admits a caller's documents through the parser, so an unadmitted one is refused", () => {
    // an admitted document goes in again unchanged
    const own = createMapper({ documents: [expectingAuthority()] });
    assert.equal(own.environment, "test");
    assert.equal(own.documentOf(PROGRAM)?.proxy_program_id, PROXY);
    const again = createMapper({ documents: [...own.documents] });
    assert.deepEqual(again.documents, own.documents);
    // a document the parser refuses never reaches the mapper
    const shadowing = expectingAuthority() as {
      instructions: Record<string, unknown>[];
    };
    shadowing.instructions.push({
      name: "other",
      discriminator: [1, 2],
      disposition: "passthrough",
      reason: "r",
    });
    assert.throws(
      () => createMapper({ documents: [shadowing] }),
      (error: unknown) =>
        error instanceof MappingDocumentError &&
        /documents\[0\] .* is a prefix of/.test(error.message),
    );
    assert.throws(
      () => createMapper({ documents: [{ schema_version: 2 }] }),
      /documents\[0\]: schema_version 2 is not 1/,
    );
    // a hole is a document that does not admit, never one that is skipped
    assert.throws(
      () => createMapper({ documents: new Array(1) }),
      (error: unknown) =>
        error instanceof MappingDocumentError &&
        error.message === "documents[0]: must be an object",
    );
  });

  it("never lets the input escape into the result", () => {
    const mapper = createMapper({ documents: [relaying()] });
    const accounts = [
      {
        address: "Thing11111111111111111111111111111111111111",
        writable: true,
        signer: false,
      },
      {
        address: "To11111111111111111111111111111111111111111",
        writable: true,
        signer: false,
      },
      {
        address: "Extra111111111111111111111111111111111111111",
        writable: false,
        signer: false,
      },
    ];
    const data = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const result = mapper.map(
      { programAddress: PROGRAM, accounts, data },
      context,
    );
    assert.equal(result.kind, "mapped");
    if (result.kind !== "mapped") return;
    assert.notEqual(result.instruction.accounts, accounts);
    assert.notEqual(result.instruction.data, data);
    data.fill(0);
    assert.notEqual(
      result.instruction.data[result.instruction.data.length - 8],
      0,
    );
    const remaining =
      result.instruction.accounts[result.instruction.accounts.length - 1]!;
    assert.notEqual(
      remaining,
      accounts[2],
      "a remaining account is copied, not shared",
    );
    assert.equal(remaining.address, accounts[2]!.address);
  });

  it("never seats the invoked program as writable or signing", () => {
    // every bundled sentinel seat, rewritten: the proxy program's id is read-only and unsigned
    for (const environment of ["production", "staging"] as const) {
      const mapper = createMapper({ environment });
      for (const document of mapper.documents) {
        for (const entry of document.instructions) {
          if (entry.disposition !== "map") continue;
          const sentinels = entry.destination_accounts.filter(
            (seat) => seat.kind === "source" && seat.sentinel === true,
          );
          if (sentinels.length === 0) continue;
          const accounts = entry.source_accounts.map((position, i) => ({
            address:
              position.expect === "glam_vault"
                ? VAULT
                : position.optional === "program_id"
                  ? document.program_id
                  : (position.expect ?? `Acct${String(i).padStart(38, "1")}`),
            writable: position.writable,
            signer: position.signer,
          }));
          const result = mapper.map(
            {
              programAddress: document.program_id,
              accounts,
              data: Uint8Array.from(entry.discriminator),
            },
            { ...context, integrationAuthority: authorityOf },
          );
          assert.equal(result.kind, "mapped", `${environment} ${entry.name}`);
          if (result.kind !== "mapped") return;
          const rewritten = result.instruction.accounts.filter(
            (account) => account.address === document.proxy_program_id,
          );
          assert.equal(rewritten.length, sentinels.length, entry.name);
          for (const account of rewritten) {
            assert.equal(account.writable, false, entry.name);
            assert.equal(account.signer, false, entry.name);
          }
        }
      }
    }
  });

  it("refuses at an expect position when the context supplies no integration authority, or a throwing one", () => {
    const mapper = createMapper({ documents: [expectingAuthority()] });
    const instruction = {
      programAddress: PROGRAM,
      accounts: [{ address: PROXY, writable: false, signer: false }],
      data: Uint8Array.from([1]),
    };
    const absent = mapper.map(instruction, context);
    assert.equal(absent.kind, "unsupported");
    if (absent.kind !== "unsupported") return;
    assert.equal(absent.reason, "context");
    assert.match(absent.message, /supplies no integration_authority/);
    const throwing = mapper.map(instruction, {
      ...context,
      integrationAuthority: () => {
        throw new Error("lookup failed");
      },
    });
    assert.equal(throwing.kind, "unsupported");
    if (throwing.kind !== "unsupported") return;
    assert.equal(throwing.reason, "context");
    assert.match(throwing.message, /lookup failed/);
    const found = mapper.map(instruction, {
      ...context,
      integrationAuthority: () => PROXY,
    });
    assert.equal(found.kind, "mapped");
  });

  it("turns a throwing integration authority lookup into a refusal, whatever it throws", () => {
    const mapper = createMapper({ environment: "production" });
    const kamino = mapper.documents.find((document) =>
      document.program_id.startsWith("KLend"),
    )!;
    const deposit = kamino.instructions.find(
      (entry): entry is Extract<typeof entry, { disposition: "map" }> =>
        entry.disposition === "map",
    )!;
    const accounts = deposit.source_accounts.map((position) => ({
      address:
        position.expect === "glam_vault"
          ? VAULT
          : (position.expect ?? "Other111111111111111111111111111111111111111"),
      writable: position.writable,
      signer: position.signer,
    }));
    const instruction = {
      programAddress: kamino.program_id,
      accounts,
      data: Uint8Array.from(deposit.discriminator),
    };
    const failed = mapper.map(instruction, {
      ...context,
      integrationAuthority: () => {
        throw new Error("lookup failed");
      },
    });
    assert.equal(failed.kind, "unsupported");
    if (failed.kind !== "unsupported") return;
    assert.equal(failed.reason, "context");
    assert.match(failed.message, /lookup failed/);
    // a thrown value that refuses conversion to text still comes back as a result
    const undescribable = mapper.map(instruction, {
      ...context,
      integrationAuthority: () => {
        throw Object.create(null) as Error;
      },
    });
    assert.equal(undescribable.kind, "unsupported");
    if (undescribable.kind !== "unsupported") return;
    assert.equal(undescribable.reason, "context");
    assert.match(undescribable.message, /cannot be described/);
  });
});
