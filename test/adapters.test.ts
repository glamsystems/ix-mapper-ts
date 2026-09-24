import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMapper,
  fromKitInstruction,
  mapKitInstruction,
  roleOf,
  toKitInstruction,
  type KitSignerOf,
} from "../src/index.js";
import {
  fromWeb3Instruction,
  mapWeb3Instruction,
  toWeb3Instruction,
} from "../src/web3.js";

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const STATE = "State11111111111111111111111111111111111111";
const VAULT = "Vau1t11111111111111111111111111111111111111";
const SIGNER = "Signer1111111111111111111111111111111111111";
const TO = "To11111111111111111111111111111111111111111";
const PAYER = "Payer11111111111111111111111111111111111111";
const EXTRA = "Extra11111111111111111111111111111111111111";
const PROGRAM = "Src1111111111111111111111111111111111111111";
const PROXY = "Proxy11111111111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const context = { glamState: STATE, glamVault: VAULT, glamSigner: SIGNER };
const transfer = Uint8Array.from([2, 0, 0, 0, 16, 39, 0, 0, 0, 0, 0, 0]);
const mappedTransfer = [
  167, 164, 195, 155, 219, 152, 191, 230, 16, 39, 0, 0, 0, 0, 0, 0,
];
const identity = (address: string) => address;

/** A document whose one entry forwards a signing payer to a signing seat after the state. */
const forwardingSigner = {
  schema_version: 1,
  environment: "test",
  program_id: PROGRAM,
  proxy_program_id: PROXY,
  instructions: [
    {
      name: "signed_forward",
      discriminator: [1],
      disposition: "map",
      handler: { name: "proxy_signed_forward", discriminator: [9] },
      source_accounts: [
        { name: "owner", writable: true, signer: true, expect: "glam_vault" },
        { name: "payer", writable: true, signer: true },
      ],
      destination_accounts: [
        {
          index: 0,
          kind: "dynamic",
          name: "glam_vault",
          writable: true,
          signer: false,
        },
        { index: 1, kind: "source", source: 1, writable: true, signer: true },
      ],
      remaining_accounts: { kind: "any" },
    },
  ],
};

/** A document whose one entry seats the GLAM signer and forwards accounts beyond its list. */
const signerSeated = {
  schema_version: 1,
  environment: "test",
  program_id: PROGRAM,
  proxy_program_id: PROXY,
  instructions: [
    {
      name: "signed",
      discriminator: [2],
      disposition: "map",
      handler: { name: "proxy_signed", discriminator: [8] },
      source_accounts: [{ name: "thing", writable: true, signer: false }],
      destination_accounts: [
        {
          index: 0,
          kind: "dynamic",
          name: "glam_signer",
          writable: true,
          signer: true,
        },
        { index: 1, kind: "source", source: 0, writable: true, signer: false },
      ],
      remaining_accounts: { kind: "any" },
    },
  ],
};

describe("the Kit adapter", () => {
  it("reads roles as writable and signer bits and writes them back", () => {
    const neutral = fromKitInstruction({
      programAddress: SYSTEM,
      accounts: [
        { address: VAULT, role: 3 },
        { address: TO, role: 1 },
        { address: STATE, role: 2 },
        { address: SIGNER, role: 0 },
      ],
      data: transfer,
    });
    assert.deepEqual(
      neutral.accounts.map((account) => [account.writable, account.signer]),
      [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ],
    );
    assert.deepEqual(
      toKitInstruction(neutral, identity).accounts.map(
        (account) => account.role,
      ),
      [3, 1, 2, 0],
    );
    assert.equal(roleOf({ address: TO, writable: false, signer: true }), 2);
    const bare = fromKitInstruction({ programAddress: SYSTEM });
    assert.deepEqual(bare.accounts, []);
    assert.equal(bare.data.length, 0);
  });

  it("copies read-only bytes rather than holding them", () => {
    // Kit's bytes are read-only at the type level; any array-like of bytes is copied
    const readOnly: ArrayLike<number> = { length: 4, 0: 2, 1: 0, 2: 0, 3: 0 };
    const neutral = fromKitInstruction({
      programAddress: SYSTEM,
      data: readOnly,
    });
    assert.ok(neutral.data instanceof Uint8Array);
    assert.deepEqual(Array.from(neutral.data), [2, 0, 0, 0]);
  });

  it("maps a Kit instruction to a Kit instruction, every address branded, the data relayed", () => {
    const mapper = createMapper({ environment: "production" });
    const branded = new Set<string>();
    const brand = (address: string) => {
      branded.add(address);
      return address;
    };
    const result = mapKitInstruction(
      mapper,
      {
        programAddress: SYSTEM,
        accounts: [
          { address: VAULT, role: 3 },
          { address: TO, role: 1 },
        ],
        data: transfer,
      },
      context,
      brand,
    );
    assert.equal(result.kind, "mapped");
    if (result.kind !== "mapped") return;
    assert.equal(
      result.instruction.programAddress,
      mapper.documentOf(SYSTEM)!.proxy_program_id,
    );
    assert.deepEqual(
      result.instruction.accounts.map((account) => account.role),
      [0, 1, 3, 0, 1, 0],
    );
    assert.equal(result.instruction.accounts[4]!.address, TO);
    assert.equal(
      result.instruction.accounts[5]!.address,
      TOKEN,
      "the Token program the handler reads for a wrapped-SOL destination",
    );
    assert.deepEqual(Array.from(result.instruction.data), mappedTransfer);
    for (const account of result.instruction.accounts) {
      assert.ok(
        branded.has(account.address),
        `${account.address} went through the brand`,
      );
      assert.equal(account.signer, undefined, "no meta carried a signer");
    }
    assert.ok(branded.has(result.instruction.programAddress));
    const unsupported = mapKitInstruction(
      mapper,
      {
        programAddress: SYSTEM,
        accounts: [
          { address: TO, role: 3 },
          { address: TO, role: 1 },
        ],
        data: transfer,
      },
      context,
      brand,
    );
    assert.equal(unsupported.kind, "unsupported");
  });

  it("keeps the caller's signer object at a signing seat and at a signing remaining account, nowhere else", () => {
    const mapper = createMapper({ documents: [forwardingSigner] });
    const payerSigner = { address: PAYER, signTransactions: () => [] };
    const vaultSigner = { address: VAULT, signTransactions: () => [] };
    const extraSigner = { address: EXTRA, signTransactions: () => [] };
    const result = mapKitInstruction(
      mapper,
      {
        programAddress: PROGRAM,
        accounts: [
          { address: VAULT, role: 3, signer: vaultSigner },
          { address: PAYER, role: 3, signer: payerSigner },
          { address: EXTRA, role: 2, signer: extraSigner },
        ],
        data: Uint8Array.from([1]),
      },
      context,
      identity,
    );
    assert.equal(result.kind, "mapped");
    if (result.kind !== "mapped") return;
    const [vault, payer, extra] = result.instruction.accounts;
    assert.equal(vault!.address, VAULT);
    assert.equal(vault!.role, 1);
    assert.equal(
      vault!.signer,
      undefined,
      "the vault seat does not sign, so it carries no signer",
    );
    assert.equal(payer!.role, 3);
    assert.equal(payer!.signer, payerSigner, "the forwarded signing seat");
    assert.equal(extra!.role, 2);
    assert.equal(extra!.signer, extraSigner, "the signing remaining account");
    assert.equal(result.instruction.accounts.length, 3);
  });

  it("gives a seat the context named the signer the caller carried for that address", () => {
    // the GLAM signer arrives as a signing remaining account with its signer object: the
    // dynamic glam_signer seat, the same address, carries it too
    const mapper = createMapper({ documents: [signerSeated] });
    const glamSigner = { address: SIGNER, signTransactions: () => [] };
    const result = mapKitInstruction(
      mapper,
      {
        programAddress: PROGRAM,
        accounts: [
          { address: TO, role: 1 },
          { address: SIGNER, role: 2, signer: glamSigner },
        ],
        data: Uint8Array.from([2]),
      },
      context,
      identity,
    );
    assert.equal(result.kind, "mapped");
    if (result.kind !== "mapped") return;
    const seats = result.instruction.accounts.filter(
      (account) => account.address === SIGNER,
    );
    assert.deepEqual(
      seats.map((seat) => seat.role),
      [3, 2],
      "the glam_signer seat signs writable, the remaining account read-only",
    );
    for (const seat of seats) assert.equal(seat.signer, glamSigner);
  });

  it("reports an address the brand refuses as a result, not a throw", () => {
    const mapper = createMapper({ environment: "production" });
    const result = mapKitInstruction(
      mapper,
      {
        programAddress: SYSTEM,
        accounts: [
          { address: VAULT, role: 3 },
          { address: TO, role: 1 },
        ],
        data: transfer,
      },
      context,
      (address: string) => {
        if (address === TO) throw new Error(`not an address: ${address}`);
        return address;
      },
    );
    assert.equal(result.kind, "unsupported");
    if (result.kind !== "unsupported") return;
    assert.equal(result.reason, "address");
    assert.equal(result.source, "transfer");
    assert.match(result.message, /not an address: To1/);
  });

  it("passes a Kit instruction through as the caller's own object", () => {
    const mapper = createMapper({ environment: "production" });
    const signer = { address: TO, signTransactions: () => [] };
    const instruction = {
      programAddress: COMPUTE_BUDGET,
      accounts: [{ address: TO, role: 3, signer }],
      data: Uint8Array.from([2, 64, 13, 3, 0]),
    };
    const result = mapKitInstruction(mapper, instruction, context, identity);
    assert.equal(result.kind, "passthrough");
    if (result.kind !== "passthrough") return;
    assert.equal(
      result.instruction,
      instruction,
      "the same object, its signer kept",
    );
    assert.equal(result.instruction.accounts[0]!.signer, signer);
  });
});

/** A stand-in for web3.js: the two classes and its byte type, as the caller hands them over. */
class Key {
  constructor(readonly address: string) {
    if (address.length < 32) throw new Error(`Invalid public key: ${address}`);
  }
  toBase58(): string {
    return this.address;
  }
}
class Instruction {
  constructor(
    readonly fields: {
      programId: Key;
      keys: { pubkey: Key; isSigner: boolean; isWritable: boolean }[];
      data: number[];
    },
  ) {}
}
const web3 = {
  PublicKey: Key,
  TransactionInstruction: Instruction,
  data: (bytes: Uint8Array) => Array.from(bytes),
};

describe("the web3.js adapter", () => {
  it("reads and builds the library's shape through the constructors it is given", () => {
    const neutral = fromWeb3Instruction({
      programId: new Key(SYSTEM),
      keys: [
        { pubkey: new Key(VAULT), isSigner: true, isWritable: true },
        { pubkey: new Key(TO), isSigner: false, isWritable: true },
      ],
      data: transfer,
    });
    assert.deepEqual(neutral.accounts, [
      { address: VAULT, writable: true, signer: true },
      { address: TO, writable: true, signer: false },
    ]);
    const built = toWeb3Instruction(neutral, web3);
    assert.equal(built.fields.programId.toBase58(), SYSTEM);
    assert.deepEqual(
      built.fields.keys.map((key) => [
        key.pubkey.toBase58(),
        key.isWritable,
        key.isSigner,
      ]),
      [
        [VAULT, true, true],
        [TO, true, false],
      ],
    );
    assert.deepEqual(built.fields.data, Array.from(transfer));
  });

  it("maps a web3.js instruction to a web3.js instruction, and passes one through as itself", () => {
    const mapper = createMapper({ environment: "production" });
    const result = mapWeb3Instruction(
      mapper,
      {
        programId: new Key(SYSTEM),
        keys: [
          { pubkey: new Key(VAULT), isSigner: true, isWritable: true },
          { pubkey: new Key(TO), isSigner: false, isWritable: true },
        ],
        data: transfer,
      },
      context,
      web3,
    );
    assert.equal(result.kind, "mapped");
    if (result.kind !== "mapped") return;
    assert.ok(result.instruction instanceof Instruction);
    assert.equal(result.instruction.fields.keys.length, 6);
    assert.equal(result.instruction.fields.keys[2]!.pubkey.toBase58(), SIGNER);
    assert.equal(result.instruction.fields.keys[2]!.isSigner, true);
    assert.equal(result.instruction.fields.keys[5]!.pubkey.toBase58(), TOKEN);
    assert.deepEqual(result.instruction.fields.data, mappedTransfer);
    const own = {
      programId: new Key(COMPUTE_BUDGET),
      keys: [],
      data: transfer,
    };
    const passthrough = mapWeb3Instruction(mapper, own, context, web3);
    assert.equal(passthrough.kind, "passthrough");
    if (passthrough.kind !== "passthrough") return;
    assert.equal(passthrough.instruction, own, "the caller's own object");
  });

  it("reports an address the library refuses as a result, not a throw", () => {
    const mapper = createMapper({ environment: "production" });
    const result = mapWeb3Instruction(
      mapper,
      {
        programId: new Key(SYSTEM),
        keys: [
          { pubkey: new Key(VAULT), isSigner: true, isWritable: true },
          { pubkey: new Key(TO), isSigner: false, isWritable: true },
        ],
        data: transfer,
      },
      { ...context, glamSigner: "short" },
      web3,
    );
    assert.equal(result.kind, "unsupported");
    if (result.kind !== "unsupported") return;
    assert.equal(result.reason, "address");
    assert.match(result.message, /Invalid public key: short/);
  });
});

// Kit's instruction shapes, structurally, as Kit 4.0.0 declares them: a plain instruction's
// metas carry no signer; an InstructionWithSigners names its metas through a type alias whose
// union adds a signer meta that extends the plain one; a signer-aware caller holds the
// intersection of the two. Inferring the meta type from that intersection collapsed
// KitSignerOf to never, so such a caller could not read a mapped signing meta's signer;
// reading it off the element type of accounts resolves it. These are checked by tsc and
// stripped at run time.
interface MirrorSigner {
  readonly address: string;
  signTransactions(): void;
}
interface MirrorAccountMeta {
  readonly address: string;
  readonly role: number;
}
interface MirrorAccountLookupMeta {
  readonly address: string;
  readonly addressIndex: number;
  readonly lookupTableAddress: string;
  readonly role: number;
}
interface MirrorAccountSignerMeta extends MirrorAccountMeta {
  readonly signer: MirrorSigner;
}
type MirrorAccountMetaWithSigner =
  | MirrorAccountLookupMeta
  | MirrorAccountMeta
  | MirrorAccountSignerMeta;
interface MirrorInstruction {
  readonly programAddress: string;
  readonly accounts?: readonly (MirrorAccountLookupMeta | MirrorAccountMeta)[];
}
type MirrorInstructionWithSigners = {
  readonly accounts?: readonly MirrorAccountMetaWithSigner[];
};
type MirrorBuilt = MirrorInstruction & {
  readonly accounts: readonly [
    MirrorAccountMeta & { readonly role: 3 } & MirrorAccountSignerMeta,
    MirrorAccountMeta & { readonly role: 0 },
  ];
};
// A caller may hold a union of instruction types, one of which declares no accounts at
// all, or two of which carry different signer types.
type MirrorBare = { readonly programAddress: string };
interface MirrorOtherSigner {
  readonly address: string;
  signMessages(): void;
}
type MirrorSigned = {
  readonly programAddress: string;
  readonly accounts: readonly MirrorAccountSignerMeta[];
};
type MirrorOtherSigned = {
  readonly programAddress: string;
  readonly accounts: readonly (MirrorAccountMeta & {
    readonly signer: MirrorOtherSigner;
  })[];
};
type IsNever<T> = [T] extends [never] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type BareOrSignedCarriesTheSigner = Assert<
  Same<KitSignerOf<MirrorBare | MirrorSigned>, MirrorSigner>
>;
export type TwoSignersCarryBoth = Assert<
  Same<
    KitSignerOf<MirrorSigned | MirrorOtherSigned>,
    MirrorSigner | MirrorOtherSigner
  >
>;
export type PlainCarriesNoSigner = Assert<
  IsNever<KitSignerOf<MirrorInstruction>>
>;
export type IntersectionCarriesTheSigner = Assert<
  KitSignerOf<
    MirrorInstruction & MirrorInstructionWithSigners
  > extends MirrorSigner
    ? true
    : false
>;
export type IntersectionIsNotNever = Assert<
  IsNever<
    KitSignerOf<MirrorInstruction & MirrorInstructionWithSigners>
  > extends false
    ? true
    : false
>;
export type BuilderTupleCarriesTheSigner = Assert<
  KitSignerOf<MirrorBuilt> extends MirrorSigner ? true : false
>;
export type BuilderTupleIsNotNever = Assert<
  IsNever<KitSignerOf<MirrorBuilt>> extends false ? true : false
>;
