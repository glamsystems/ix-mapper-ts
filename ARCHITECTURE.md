# ix-mapper architecture and instruction policy

Status: accepted
Decision date: 2026-08-03

This document is the durable architecture decision for GLAM protocol
integrations and the normative permissionless-instruction policy enforced by
`ix-mapper`.

## Architectural model

The design follows the same separation as `incident-client`:

- the neutral GLAM core is analogous to `IncidentClient`: a small domain
  contract independent of a Solana client library;
- the first-party Solana Kit binding is analogous to
  `PagerDutyIncidentClient`: the official implementation of that contract;
- Kit remains directly usable, like the provider-native
  `PagerDutyEventClient`.

For protocol integrations, the call path is:

```text
application
  -> official protocol SDK directly
     or approved bounded operation binding (SDK-differential-tested)
  -> strict ix-mapper core
  -> mapped GLAM proxy instruction or reviewed native passthrough
  -> transaction composition and submission through the GLAM Kit binding
```

The official protocol SDK is the semantic and differential-conformance
authority for reserve selection, protocol-state discovery, setup and cleanup,
instruction ordering, and native instruction construction. Prefer executing it
directly. When its published runtime graph cannot execute in a target such as
Hermes, a protocol adapter may carry a **named bounded portable operation
binding** for exact reads, derivations, instruction construction, and ordering.
That exception must match the pinned official SDK byte-for-byte and
account-for-account, fail closed outside the named operation/version, and still
send every emitted instruction through this mapper. It is not a general GLAM
Kamino SDK, generic protocol client, or untrusted planner.

## Package boundaries

The package root is the target first-class neutral entrypoint. `/core` remains
an explicit equivalent subpath for consumers that prefer named boundaries.
Their contract uses only:

- base58 address strings;
- numeric account roles (`0..3`);
- `Uint8Array` instruction data;
- plain tagged result objects.

The core does not import Kit, Anchor, web3.js, Node `Buffer`, RPC clients,
signers, or transaction types. Kit instructions satisfy its structural input
directly; a Kit -> web3.js -> Kit conversion is forbidden.

`@glamsystems/ix-mapper/legacy-web3` is the explicit compatibility entrypoint.
It converts web3.js values at the edge and delegates strict decisions to the
neutral core. web3.js is an optional peer installed only by consumers of that
entrypoint. The dependency direction must never reverse.

The `0.3.0-test.1` proof switches the package root to the neutral API and keeps
the legacy facade only at `/legacy-web3`. web3.js is an optional peer and a
packed-consumer gate proves that a root/core-only install neither installs nor
bundles it. Legacy byte/account parity remains an independent release gate.

## Result contract

Every input produces exactly one result:

- `mapped`: a reviewed mapping creates an instruction for an `ext_*` proxy;
- `safePassthrough`: an exact reviewed rule permits the original native
  instruction unchanged;
- `unsupported`: the whole operation must stop.

Complete operation profiles return `mappedOperation` only after every setup
and protocol instruction passes. Any failure returns one `unsupported` result
with the failing source index (or `null` for an operation-wide shape failure)
and no partial instruction list.

Callers must preserve official-SDK ordering and inspect every result. They may
not drop an unsupported result, infer safety from a missing mapping, or replace
the signer or economic source of an instruction mechanically.

## Permissionless-instruction policy

Protocol-level permissionlessness is not a mapper classification and never
implies passthrough. An instruction is `safePassthrough` only when a versioned,
reviewed rule matches all of the following:

- exact program ID;
- exact discriminator;
- exact constrained data bytes (schema v1 has no wildcard payload rule);
- exact account count and ordered signer/writable roles;
- one explicit identity constraint for every account;
- no remaining accounts;
- a stable rule ID, emitter, condition, phase, and rationale.

Safe passthrough executes the native instruction; it is never proxied through
GLAM. Unknown programs, unknown discriminators, different data, changed roles,
changed identities, additional accounts, and instructions described as
permissionless but absent from the allowlist are `unsupported`.

The current Kamino proof approves no global passthrough rules. Standalone ATA
creation, `SyncNative`, memo, farms, WSOL setup/cleanup, and every other helper
remain unsupported. A separate operation profile permits one exact
CreateIdempotent ATA only at position zero of the reviewed classic KVault
deposit/withdraw sequence, with its payer, GLAM-vault owner, mint, token
program, and derived ATA bound to the mapped native instruction(s). It is
never considered by the standalone instruction mapper. Signer-bearing value
transfers and account closes require a strict GLAM mapping rather than native
passthrough.

The raw operation matcher proves only that the complete list presented to it
matches the operation profile. Provenance belongs to the bounded adapter: it
constructs the named operation and submits its immutable output directly to
the matcher without exposing a spliceable intermediate list.

The KVault profile pins Kamino Farms to the Farms SDK's default program ID.
Deposit helpers already use that default; `KaminoVaultClient.farmsProgramId`
must be omitted or equal the pinned address for withdraw. A client configured
with any other Farms program is outside the compatibility profile and its
instructions remain unsupported.

## Versioned evidence

Compatibility is one exact tuple, not a range:

- official protocol SDK package, version, integrity, and tarball hash;
- Solana Kit package and version used by the tested instruction model;
- mapper package version;
- mapping schema and config revision plus config hash;
- instruction-classification schema and config revision plus config hash;
- complete-operation profile schema and config revision plus config hash;
- compatibility-manifest schema and manifest revision;
- native and proxy program IDs, proxy version, IDLs, and source hashes.

The mapping configs define proxy transformations. The adjacent
`instruction-classifications-v1/` profile inventories official-SDK protocol,
setup, and cleanup emissions as `mapped`, `safePassthrough`, or `unsupported`.
The adjacent `operation-profiles-v1/` artifact separately defines reviewed
all-or-nothing sequences and operation-bound passthrough. Compatibility
manifest v2 pins all three. Absence from either applicable runtime allowlist
always means `unsupported`, even if a prose inventory entry calls an
instruction permissionless.

Any official SDK, Kit, IDL, proxy, mapper, config, or manifest change invalidates
the tuple until regenerated evidence and tests pass.

Deployment and public maturity are independent axes. Every production and
staging tuple carries one maturity value:

- `proof-only`: internal evidence, absent from default public discovery;
- `preview`: explicit opt-in with a complete immutable tuple, all runtime and
  safety gates green, and no unclassified emitted instruction;
- `supported`: stable public contract;
- `withdraw-only`, `hold`, or `deprecated`: explicit recovery, restriction, or
  sunset state.

Onchain staging never implies preview or support. Kamino 9.1.5 and Kamino 10
are separate tuples; evaluating or promoting one cannot mutate the other's
manifest or artifacts.

## GLAM SDK transition

The neutral GLAM domain core stays inside the existing public SDK lineage. The
GLAM SDK adds a Kit-first binding that implements only narrow domain ports for
account reads, signing, submission, confirmation/observation, and serialized
transaction boundaries. It does not wrap Kit's RPC surface.

The legacy Anchor/web3.js facade delegates inward to the neutral core. Consumers
migrate incrementally; legacy public APIs are removed only in a major release.
Existing signer, sender, DTO, and serialized-byte boundaries remain stable when
they already express the domain contract.

## Release gates

A compatibility profile cannot be marked preview or supported until all of
these pass:

- official Kit-shaped instructions map through the neutral entrypoint without
  legacy normalization;
- neutral and legacy paths produce byte/account-equivalent results;
- unknown and unapproved instructions fail closed;
- every official-SDK helper emission in the supported profile is classified;
- the neutral bundle and declarations contain no Kit, Anchor, or web3.js
  dependency;
- exact versions, revisions, and artifact hashes agree;
- Node, web, Expo/Hermes, and dependency-graph runtime gates pass.

The Kamino KVault manifest remains `proof-only` until the bounded convenience
API and client-runtime blockers are resolved. The operation profile does not
promote memo, farms, WSOL, minimum-shares, available-withdraw, or close-account
branches.
