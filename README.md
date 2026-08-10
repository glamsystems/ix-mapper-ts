# ix-mapper

`ix-mapper` is GLAM's strict instruction boundary. The pinned official SDK is
the semantic/conformance authority. A named bounded portable operation binding
is permitted only when that SDK cannot execute in a target runtime; its output
must still match the SDK exactly and cross this mapper. The mapper returns a
mapped GLAM proxy instruction, an explicitly allowlisted native passthrough, or
an unsupported result.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the accepted SDK architecture and
the normative permissionless-instruction policy.

## Installation

```bash
npm install @glamsystems/ix-mapper
```

The proof package is verified on Node 22.22 and Node 24 with the exact npm
version recorded in `packageManager`. Stable publication remains blocked while
its compatibility manifests are `proof-only`.

## Neutral, Kit-compatible API

The package root is the first-class neutral entrypoint, with `/core` as an
explicit equivalent subpath. The `0.3.0-test.1` packed-consumer gate proves
that a neutral install has no Kit, Anchor, or web3.js runtime dependency and
does not install the optional web3.js peer. Official SDK instructions shaped
like Kit instructions pass directly into it.

```typescript
import { address } from "@solana/kit";
import { createNeutralMapper } from "@glamsystems/ix-mapper/core";

const mapper = createNeutralMapper({
  normalizeAddress(value) {
    return address(value);
  },
});

const nativeInstruction = buildWithOfficialProtocolSdk();
const context = deriveWithGlamKitBinding();
const result = mapper.mapInstructionNeutral(nativeInstruction, context, {
  staging: false,
});

switch (result.kind) {
  case "mapped":
  case "safePassthrough":
    transactionInstructions.push(result.instruction);
    break;
  case "unsupported":
    throw new Error(`${result.reason}: ${result.message}`);
}
```

The GLAM Kit binding owns PDA derivation and supplies the narrow mapping
context. The mapper does not fetch protocol state, choose reserves, reproduce
protocol SDK logic, sign, submit, or confirm transactions.

Every ordered official-SDK instruction must be mapped and checked. Any
`unsupported` result aborts the complete operation.

## Result meanings

- `mapped`: a versioned strict mapping validated the complete source and
  destination layout.
- `safePassthrough`: one exact reviewed rule permits the original native
  instruction unchanged.
- `unsupported`: the program, instruction, data, accounts, or compatibility
  tuple is not approved.

“Permissionless” never means automatic passthrough. A safe rule must pin the
program, discriminator, exact data constraint, account count, ordered roles,
account identities, emitter, condition, and rationale. Unknown or changed
instructions fail closed.

The current `0.3.0-test.1` Kamino proof has no globally approved passthrough
rules. Its two operation-bound ATA approvals are invisible to the standalone
instruction mapper.

## Kamino proof scope

The proof calls the pinned official `@kamino-finance/klend-sdk` generated KVault
builders and strictly maps the inner `deposit` and `withdraw`
instructions. It deliberately rejects `depositWithMinSharesOut`,
`withdrawFromAvailable`, and unapproved setup/cleanup instructions.

That is the initial audited proof, not the final KVault target. The existing
`deposit`/`withdraw` proxy paths remain available while the two additional
proxy instructions complete separate program-size, audit, staging,
deployment, mapping, and artifact gates. Their source presence never changes
the current proof manifest from `unsupported`.

The versioned complete-operation profile recognizes only `[exact ATA,
deposit]` and `[exact ATA, withdraw...]`. It binds the setup payer, canonical
ATA, GLAM-vault owner, mint, token program, ordering, and classic mapped
instructions, and it returns no partial output on failure. Standalone ATA is
still unsupported. The raw matcher proves the presented sequence, while the
bounded adapter owns SDK provenance and must construct and map without
exposing a spliceable helper list.

The helpers can also emit memo, farm, WSOL, close-account, and alternative
KVault instructions. Those branches remain unsupported; protocol-level
permissionlessness does not allow callers to strip or pass them through.

The manifest also pins the Farms SDK default program ID. A custom
`KaminoVaultClient.farmsProgramId` is outside this proof profile and fails
closed.

## Versioned compatibility evidence

Published packages include:

```text
mapping-configs-v2*/
instruction-classifications-v1/
operation-profiles-v1/
artifacts/
compatibility-manifests/
```

The manifests pin the exact official SDK, Kit instruction model, mapper,
mapping config, classification config, proxy, IDLs, source artifacts, revisions,
and hashes. Verify a checkout with:

```bash
npm run verify:artifacts
```

Stable releases reject `proof-only` manifests. The initial Kamino manifests
remain proof-only while the official SDK package graph fails the Next,
Expo/Hermes, and dependency-peer gates.

Deployment (`production` or `staging`) is separate from public maturity:
`proof-only` is internal, `preview` is explicit opt-in with complete gates,
`supported` is stable, and `withdraw-only`/`hold`/`deprecated` are explicit
restricted states. Separately versioned SDK evaluations live under
`compatibility-evaluations/`; they never overwrite an existing manifest.

## Legacy web3.js compatibility

Existing consumers may import:

```typescript
import { mapInstruction, mapInstructions, mapToGlamIx } from "@glamsystems/ix-mapper/legacy-web3";
```

`mapInstruction` and `mapInstructions` convert web3.js values at the explicit
legacy boundary and delegate to the neutral strict core. web3.js is an
optional peer used only by consumers of this subpath. `mapToGlamIx` retains
nullable v1 behavior only for legacy consumers and must not be used for new
integrations.

Legacy nullable results never authorize native passthrough. `fixSignerAccounts`
also remains compatibility-only because mechanical signer replacement can
change an instruction's economic meaning.
