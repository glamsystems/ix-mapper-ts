# ix-mapper

TypeScript SDK for mapping Solana program instructions to GLAM proxy instructions.

## Supported Programs

See `mapping-configs-v1/`.

## Installation

```bash
npm install @glamsystems/ix-mapper
```

## Usage

```typescript
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { mapToGlamIx } from "@glamsystems/ix-mapper";

// GLAM vault and state PDAs
const glamVault = new PublicKey("...");
const glamState = new PublicKey("...");

// Signer should be vault owner or a delegate
const glamSigner = new PublicKey("...");

// Build a system transfer instruction with expected params
// Transfer lamports from GLAM vault to `recipient`
const transferIx = SystemProgram.transfer({
  fromPubkey: glamVault,
  toPubkey: recipient,
  lamports,
});

// Transform to GLAM instruction, then you can build a transaction with it
const glamInstruction = mapToGlamIx(transferIx, glamState, glamSigner);
```

## Mapping Configuration

Mapping configurations are stored in JSON files under `mapping-configs-v0/` (deprecated) and `mapping-configs-v1/`. Each configuration file specifies:

- `program_id` - The source program ID
- `proxy_program_id` - The GLAM integration program ID
- `instructions` - Array of instruction mappings containing:
  - `src_discriminator` - Original instruction discriminator bytes
  - `dst_discriminator` - GLAM proxy instruction discriminator bytes
  - `dynamic_accounts` - GLAM-specific accounts to inject (state, vault, signer, integration authority)
  - `static_accounts` - Additional static accounts required by the proxy
  - `index_map` - Array mapping original account indices (-1 means drop the account)
