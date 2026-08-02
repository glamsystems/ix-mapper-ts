# Kamino Deposit via GLAM Vault

Legacy Kamino Lending demonstration retained for migration reference. It uses
the nullable v1 mapper and is not the current KVault/strict integration
template; new work must use the neutral fail-closed API described in the root
README.

## What it does

1. Loads the Kamino lending market and builds raw USDC deposit instructions with the vault PDA as owner
2. Passes each instruction through `mapToGlamIx()` and aborts if any instruction
   is not mapped; a missing v1 mapping never authorizes passthrough
3. Fixes signer accounts so the wallet (not the vault PDA) pays fees
4. Builds a versioned transaction and simulates it on mainnet

## Prerequisites

- Node.js >= 20
- pnpm
- A Solana mainnet RPC URL (must support `getProgramAccounts`)
- A wallet keypair JSON file for a GLAM vault manager
- A GLAM vault state PDA

## Setup

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable              | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `ANCHOR_PROVIDER_URL` | Mainnet RPC endpoint                                                  |
| `ANCHOR_WALLET`       | Path to manager keypair JSON                                          |
| `GLAM_STATE`          | Vault state PDA address                                               |
| `GLAM_STAGING`        | `true` for staging programs, `false` for production (default: `true`) |
| `DEPOSIT_AMOUNT`      | Amount in USDC lamports (default: `1000000` = 1 USDC)                 |

## Run

```bash
pnpm install
pnpm dev
```

The script prints a mapping report and stops at the first unmapped instruction.
It is expected to stop when the official SDK emits setup instructions outside
the old v1 mapping set.
