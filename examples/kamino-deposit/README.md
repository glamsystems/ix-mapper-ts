# Kamino Deposit via GLAM Vault

End-to-end example that uses Kamino's official `klend-sdk` to build raw deposit instructions, then maps them through `@glamsystems/ix-mapper` for execution via a GLAM vault.

## What it does

1. Loads the Kamino lending market and builds raw USDC deposit instructions with the vault PDA as owner
2. Passes each instruction through `mapToGlamIx()` — Kamino Lending instructions are mapped to the GLAM `ext_kamino` proxy program; others (ATA creation, compute budget) are kept as-is
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

| Variable | Description |
|---|---|
| `ANCHOR_PROVIDER_URL` | Mainnet RPC endpoint |
| `ANCHOR_WALLET` | Path to manager keypair JSON |
| `GLAM_STATE` | Vault state PDA address |
| `GLAM_STAGING` | `true` for staging programs, `false` for production (default: `true`) |
| `DEPOSIT_AMOUNT` | Amount in USDC lamports (default: `1000000` = 1 USDC) |

## Run

```bash
pnpm install
pnpm dev
```

The script will print a mapping report showing which instructions were mapped to the GLAM proxy and which were kept as-is, followed by the simulation result.
