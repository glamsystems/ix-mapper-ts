# ix-mapper

`ix-mapper` is GLAM's strict instruction boundary. External-protocol semantics
stay in the protocol's official SDK; the mapper validates the SDK's native
instructions and returns a mapped GLAM proxy instruction, an explicitly
allowlisted native passthrough, or an unsupported result.

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

`@glamsystems/ix-mapper/core` is the first-class entrypoint. It has no Kit,
Anchor, or web3.js runtime dependency. Official SDK instructions shaped like
Kit instructions pass directly into it.

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

The current `0.3.0-test.0` Kamino proof has no approved passthrough rules.

## Kamino proof scope

The proof calls the pinned official `@kamino-finance/klend-sdk` generated KVault
builders and strictly maps the inner `deposit` and classic `withdraw`
instructions. It deliberately rejects `depositWithMinSharesOut`,
`withdrawFromAvailable`, and unapproved setup/cleanup instructions.

The high-level KVault helpers are not yet supported end to end. They always emit
ATA creation and can conditionally emit memo, farm, WSOL, close-account, and
alternative KVault instructions. The versioned classification profile records
each known branch; callers must not pass any of them through merely because the
native protocol calls one permissionless.

The manifest also pins the Farms SDK default program ID. A custom
`KaminoVaultClient.farmsProgramId` is outside this proof profile and fails
closed.

## Versioned compatibility evidence

Published packages include:

```text
mapping-configs-v2*/
instruction-classifications-v1/
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

## Legacy web3.js compatibility

Existing consumers may import:

```typescript
import { mapInstruction, mapInstructions, mapToGlamIx } from "@glamsystems/ix-mapper/legacy-web3";
```

The package root remains a compatibility alias. `mapInstruction` and
`mapInstructions` convert web3.js values at that boundary and delegate to the
neutral strict core. `mapToGlamIx` retains nullable v1 behavior only for legacy
consumers and must not be used for new integrations.

Legacy nullable results never authorize native passthrough. `fixSignerAccounts`
also remains compatibility-only because mechanical signer replacement can
change an instruction's economic meaning.
