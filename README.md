# @glamsystems/ix-mapper

Maps an instruction a protocol's own SDK built onto the GLAM instruction that carries it.
A user keeps building with Kamino's, Jupiter's or the System program's SDK, in Solana Kit
or web3.js, and hands each instruction to the mapper; back comes the GLAM proxied
instruction, the same instruction when GLAM lets it through unchanged, or the reason it is
refused. The mapping documents ship inside the package, one per source program and
environment, generated from the GLAM programs' IDLs. The package depends on nothing at
run time.

## Use

```ts
import { address } from "@solana/kit";
import { createMapper, mapKitInstruction } from "@glamsystems/ix-mapper";

const mapper = createMapper({ environment: "production" });
const result = mapKitInstruction(mapper, instruction, { glamState, glamVault, glamSigner, integrationAuthority: (proxyProgram) => authorities.get(proxyProgram) }, address);
switch (result.kind) {
  case "mapped": // result.instruction targets the GLAM program; result.handler names the handler
  case "passthrough": // result.instruction is the input; result.reason says why it rides along
  case "unsupported": // result.reason classifies it, result.message says which account or rule
}
```

`createMapper` takes an environment for the bundled documents, or `documents` of the
caller's own, parsed JSON or already admitted. It admits each through
`parseMappingDocument` and throws `MappingDocumentError` for one that does not admit, or
for a set that forms no mapper: none, two environments, or two documents for one program.
The context supplies the three GLAM accounts a document may seat and, for documents that
seat one, the integration authority of a proxy program; the mapper derives no address.
Mapping never throws, a throwing `integrationAuthority` included; an address the caller's
address library refuses comes back as an `unsupported` result with reason `address`.

A Kit instruction is taken as an address, account roles and bytes, so any Kit version
fits. A mapped result is built with the `address` function the caller passes, so its
addresses carry Kit's brand and its roles are Kit's four account roles, and each signing account
keeps the `signer` object the caller's meta of that address carried, on a signing role
only, so the result is an `InstructionWithSigners` and Kit's signer-aware flow still finds
it; a seat the context named, the `glam_signer` seat
included, carries one only when the caller's instruction carried one for that address,
and otherwise the fee-payer signer covers it. A passed-through result is the caller's own instruction object, signers
and all. A mapped instruction carries every account as a static address, without the
lookup-table metadata a Kit meta may carry: mapped instructions are built for version 1
transactions, whose limits make lookup tables unnecessary. A web3.js v1 instruction goes through `mapWeb3Instruction` from
`@glamsystems/ix-mapper/web3`, which takes the library's `PublicKey` and
`TransactionInstruction` classes and `Buffer.from` from the caller to build a mapped
result, so the package imports neither library. The Stake documents follow the
sysvar-free account layout the generated builders in `@solana-program/stake` use; the
web3.js v1 `StakeProgram` builders carry the clock and stake-history sysvars, and the
mapper refuses them.

## The document

`src/generated/mapping/{production,staging}/<program id>.json`, one per source program.
Top level: `schema_version`, `environment`, `program_id`, `proxy_program_id`, `provenance`
(the generator commit, the IDL store revisions, the config revision) and `instructions`.
Every instruction of the program appears once, with its `discriminator` and a
`disposition`:

- `map`: `handler` names the GLAM instruction and its discriminator. `source_accounts`
  lists the source instruction's positions in order, each with the flags the source IDL
  declares, `optional` when the account may be absent (`omitted`: a client leaves a
  trailing one out of the list; `program_id`: a client passes the source program's id in
  its place), `dynamic_signer` when the IDL leaves the signer privilege to the caller,
  whose choice the mapper keeps at an unsigned seat, and `expect` when the mapper must find
  a particular account there: the account the handler
  seats in its place, so an instruction built for anything else is refused rather than
  silently redirected. That is `glam_vault` at every dropped signer, owner or authority
  the vault stands in for; `glam_signer` or `glam_vault` at a dropped payer, whichever the
  handler pays from, and at a dropped refund destination the handler pays to; and the
  pinned address at a position a fixed account of the handler covers.
  `destination_accounts` lists the seats of the mapped instruction, dense from 0, each
  with the flags the handler declares, a forwarded seat writable also when the native
  position is (the handler passes the account on with the flags it received): a `dynamic`
  GLAM account by name, a `static` address, or a `source` position forwarded; a `sentinel`
  seat is an optional account of
  the handler's own, where the source program's id (an absent optional, as Anchor clients
  pass it) becomes the proxy program's id. A `supplied` account, such as a routing table of
  the extension's own, is a declared account of the handler that no native instruction
  carries. The context supplies it at its account index. It names a `role` the mapper does
  not interpret, keeps the handler's `writable` flag and never signs. Its `derivation` is
  present when the handler's IDL has one. It names the `program` the address derives under
  and the `seeds` in order. A `const` seed carries its `value` bytes, at most 32. An
  `account` seed names an account index of the mapped instruction in its `index`. An `arg`
  seed names an instruction argument in its `path`. `supplied_accounts` lists, in order,
  accounts the
  context supplies after the seats: a handler reads them from its remaining accounts and a
  native instruction never carries them (a pool's price oracles, a strategy's market). Each
  names a `role` the mapper does not interpret, the source positions (`of`) whose addresses
  the supplier receives with it, and `optional` when the supplier may leave it out; optional
  ones trail the required ones. `remaining_accounts` says what to do with
  accounts beyond the listed positions: `any` forwards them after the seats, `none`
  refuses them.
- `passthrough`: forwarded unchanged. The `reason` says why: the instruction's declared
  accounts carry no signer, or a reviewed rationale.
- `unsupported`: refused, with the `reason`: no GLAM handler proxies it, it declares no
  accounts so nothing says which of the accounts it takes sign (the Token programs'
  `batch`, whose nested instructions carry their own authorities inside its data), the
  handler needs accounts a native instruction never carries and the document does not list
  them as supplied, it is left out by configuration, or why the generator could not derive
  its handler.

## The rules

At load, `parseMappingDocument` refuses an unknown field or label anywhere, a schema
version it does not know, seats that are not dense from 0, a source position forwarded
twice or forwarded read-only while the native position is writable, an omittable optional
ahead of a required position, a seat after an omittable one or omittable seats out of
source order, a sentinel seat that does not forward an optional the client passes as the
program id, an unknown dynamic account, a discriminator that is a prefix of another's,
since matching is by prefix, and supplied accounts on a `passthrough` or `unsupported`
entry or on an entry with a seat a client may leave out (an absent seat would shift them),
naming a position outside the list or an optional one (a client may leave it out or pass
the program id in its place), or a required one after an optional one. It also refuses a
supplied account at an account index that signs. It refuses a derivation whose account seed
names an account index outside the list, or an account a client may leave out. It refuses
one whose account seed names the account index of any supplied account, its own included,
as that address is the supplier's own answer. It refuses a constant seed longer than 32
bytes.

At mapping time, an instruction of a program with no document passes through: GLAM does
not proxy that program. For a documented program, the entry whose discriminator prefixes
the data decides: `passthrough` returns the input, `unsupported` refuses with the
document's reason, and no entry refuses too. A `map` entry refuses a source shorter than
its list unless every missing position is a trailing omittable optional, an account that
is not what an `expect` position names, a forwarded account whose signer privilege
disagrees with its seat (at a `dynamic_signer` position, only an unsigned account at a
signing seat), and accounts beyond the list when the rule is `none`. It sets the handler's
flags on every seat rather than copying the source's, with two exceptions. The source
program's id at a sentinel seat becomes the proxy program's id, read-only and unsigned, as
an absent optional reaches an Anchor program, since the invoked program is never a
writable account. An account at a `dynamic_signer` position keeps the caller's signer flag
at an unsigned seat and must sign at a signing seat. The handler passes it on with the
privilege it received. For an entry with
supplied accounts it asks the context's supplier once, with the roles and the addresses at
their `of` positions and the instruction itself, and inserts the answer after the seats,
read-only and unsigned, in the answer's order: no supplier, a null answer or a supplier
that throws refuses with `context`, a count outside the required and optional bounds or a
null account with `supplied_accounts`. Supplied accounts at an account index join the same
request ahead of the appended roles. Their roles run in account-index order, and each
counts as required and carries no `of` addresses. A role carries a `derivation` key only
when the document derives its account. The mapper resolves that derivation: an `account`
seed becomes the address the mapper placed at that account index. A `const` seed keeps its
bytes and an `arg` seed keeps its path, and the mapper derives no address itself. The first answers go to those account indexes, unsigned and with the handler's
`writable` flag. The rest follow the declared accounts as before. It forwards remaining accounts after that with the flags the caller
gave them, and relays the data verbatim behind the swapped discriminator. The Java mapper,
`ix-mapper-java`, reads the same documents and implements the same rules; the conformance
cases under `test/data/cases` are the contract both run.
