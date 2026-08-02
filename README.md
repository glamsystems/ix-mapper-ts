# ix-mapper

GLAM vaults execute external-protocol instructions through `ext_*` proxy
programs that enforce permissions and policy onchain. `ix-mapper` transforms a
reviewed native instruction into its matching GLAM proxy instruction and fails
closed when the program, instruction, data, accounts, or compatibility shape is
not explicitly supported.

The mapper does not fetch protocol state, select reserves or markets, decide
slippage, or reproduce an external protocol's SDK. Those semantics remain in
the protocol's official SDK.

## Installation

```bash
npm install @glamsystems/ix-mapper
```

## Fail-closed API

Use `mapInstruction` for new integrations:

```typescript
import { PublicKey } from "@solana/web3.js";
import { mapInstruction } from "@glamsystems/ix-mapper";

const nativeInstruction = buildWithOfficialSdk();
const glamState = new PublicKey("...");
const governanceSigner = new PublicKey("...");

const result = mapInstruction(
  nativeInstruction,
  glamState,
  governanceSigner,
  { staging: false },
);

switch (result.kind) {
  case "mapped":
  case "safePassthrough":
    transaction.add(result.instruction);
    break;
  case "unsupported":
    throw new Error(`${result.reason}: ${result.message}`);
}
```

`mapInstruction` accepts both web3.js `TransactionInstruction` values and the
Solana Kit-shaped instructions returned by current official Kamino builders.
Use the exported `normalizeInstruction` helper only when composition code needs
the equivalent web3.js value before mapping; it validates Kit account roles and
fails on missing byte data.

Every input receives one explicit result:

- `mapped`: a schema-v2 mapping validated the complete source and destination
  layouts.
- `safePassthrough`: an audited rule allows the instruction unchanged. No
  passthrough rules ship in the initial `0.3.0-test.0` compatibility proof.
- `unsupported`: the caller must abort the complete operation. Unknown must
  never be treated as native passthrough.

`mapInstructions` applies the same contract to an ordered sequence and returns
one result for every input without dropping failures:

```typescript
const results = mapInstructions(
  officialSdkInstructions,
  glamState,
  governanceSigner,
);

if (results.some((result) => result.kind === "unsupported")) {
  throw new Error("The official SDK emitted an unsupported instruction");
}
```

The initial schema-v2 set supports the generated inner Kamino KVault `deposit`
and `withdraw` instructions. The golden fixtures intentionally call the pinned
official SDK's generated builders; they do not claim compatibility with a full
high-level helper sequence. Those helpers can also emit ATA, WSOL setup/cleanup,
or `withdrawFromAvailable` instructions, so callers must map and require success
for every instruction in the returned sequence. Operations such as
`depositWithMinSharesOut` and
`withdrawFromAvailable` are deliberately unsupported until the onchain proxy,
permission model, program-size impact, and audit cost are reviewed.

## What schema v2 validates

Before mapping, the strict API validates:

- the exact native program and instruction discriminator;
- the exact instruction data length;
- every fixed source account's position and signer/writable privileges;
- fixed program, token-program, sysvar, event-authority, and other reviewed
  addresses;
- required account equality and GLAM-vault-PDA identity;
- bounded, structured remaining accounts rather than an arbitrary suffix;
- the destination program, discriminator, payload, account count, ordering,
  identities, and privileges after transformation.

Malformed untrusted instructions return `unsupported`. Invalid bundled config
is rejected when the package initializes.

## Versioned compatibility artifacts

The npm package includes the reviewed schema-v2 configs, native/proxy IDLs, and
machine-readable compatibility manifests under:

```text
mapping-configs-v2*/
artifacts/
compatibility-manifests/
```

Each manifest pins the official SDK, relevant resolved dependencies, native and
proxy program IDs, IDL and instruction-schema hashes, mapper/config versions,
supported mappings, explicit rejections, and runtime gates. From a source
checkout or release CI, run:

```bash
npm run verify:artifacts
```

Release CI additionally downloads the exact official SDK tarball named by the
lockfile and verifies the manifest's SHA-256. Stable package versions reject
any bundled manifest still marked `proof-only`; this initial proof therefore
uses the `0.3.0-test.0` prerelease and the npm `test` dist-tag.

The first Kamino manifests are marked `proof-only`: Node golden fixtures pass,
while the official SDK's current package graph does not pass Next client or
Expo/Hermes runtime gates. A manifest cannot be marked `supported` while any
runtime gate is false or a known blocker remains.

## Legacy API

`mapToGlamIx(ix, glamState, glamSigner, staging?)` remains available for
existing consumers. It returns `TransactionInstruction | null` and uses the
legacy v1 mappings.

The nullable result cannot distinguish an unsupported instruction from one a
caller might believe is safe to pass through, so it must not be used as the
boundary for new official-SDK integrations. Migrate new and updated flows to
`mapInstruction`/`mapInstructions`.

`fixSignerAccounts` also remains for compatibility. The strict path does not
call it because mechanically replacing signers can change the economic source
or destination of an instruction.

## Staging

Pass `{ staging: true }` to select the staging GLAM core and proxy programs:

```typescript
const result = mapInstruction(nativeInstruction, glamState, signer, {
  staging: true,
});
```

Staging selection is part of the mapping context and should be persisted by
durable transaction plans rather than inferred from ambient process state.
