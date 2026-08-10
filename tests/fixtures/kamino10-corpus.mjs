import { PublicKey } from "@solana/web3.js";

export const ids = Object.freeze({
  kvault: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
  klend: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  system: "11111111111111111111111111111111",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
});

const key = () => new PublicKey(PublicKey.unique()).toBase58();
export const address = () => key();
export const signer = () => ({ address: key() });

/** Convert a Kit instruction into the exact differential-test representation. */
export function canonical(ix) {
  return {
    programAddress: ix.programAddress,
    dataHex: Buffer.from(ix.data ?? []).toString("hex"),
    accounts: (ix.accounts ?? []).map(({ address, role }) => ({
      address,
      role,
    })),
  };
}

export function reservePairs(count) {
  const reserves = Array.from({ length: count }, () => ({
    address: address(),
    role: 1,
  }));
  const markets = Array.from({ length: count }, () => ({
    address: address(),
    role: 0,
  }));
  return [...reserves, ...markets];
}

export function depositAccounts(user, tokenProgram = ids.token) {
  return {
    user,
    vaultState: address(),
    tokenVault: address(),
    tokenMint: address(),
    baseVaultAuthority: address(),
    sharesMint: address(),
    userTokenAta: address(),
    userSharesAta: address(),
    klendProgram: ids.klend,
    tokenProgram,
    sharesTokenProgram: ids.token,
    eventAuthority: address(),
    program: ids.kvault,
  };
}

export function withdrawAccounts(user, tokenProgram = ids.token) {
  const vaultState = address();
  return {
    withdrawFromAvailable: {
      user,
      vaultState,
      globalConfig: address(),
      tokenVault: address(),
      baseVaultAuthority: address(),
      userTokenAta: address(),
      tokenMint: address(),
      userSharesAta: address(),
      sharesMint: address(),
      tokenProgram,
      sharesTokenProgram: ids.token,
      klendProgram: ids.klend,
      eventAuthority: address(),
      program: ids.kvault,
    },
    withdrawFromReserveAccounts: {
      vaultState,
      reserve: address(),
      ctokenVault: address(),
      lendingMarket: address(),
      lendingMarketAuthority: address(),
      reserveLiquiditySupply: address(),
      reserveCollateralMint: address(),
      reserveCollateralTokenProgram: ids.token,
      instructionSysvarAccount: "Sysvar1nstructions1111111111111111111111111",
    },
    eventAuthority: address(),
    program: ids.kvault,
  };
}

/**
 * Minimal state for official high-level helper emission. It deliberately has no
 * RPC methods: tests must provide only the two documented withdrawal seams.
 */
export function helperState(BN, tokenProgram = ids.token, reserveCount = 1) {
  const reserves = Array.from({ length: reserveCount }, () => address());
  const reserveMap = new Map(
    reserves.map((reserve) => [
      reserve,
      {
        state: {
          lendingMarket: address(),
          liquidity: { supplyVault: address() },
          collateral: { mintPubkey: address() },
        },
      },
    ]),
  );
  return {
    vault: {
      address: address(),
      async getState() {
        return this.state;
      },
      state: {
        tokenMint: address(),
        tokenProgram,
        tokenVault: address(),
        baseVaultAuthority: address(),
        sharesMint: address(),
        sharesMintDecimals: new BN(0),
        tokenMintDecimals: new BN(0),
        sharesIssued: new BN(100),
        tokenAvailable: new BN(0),
        vaultFarm: ids.system,
        firstLossCapitalFarm: ids.system,
        vaultAllocationStrategy: reserves.map((reserve) => ({ reserve })),
      },
    },
    reserveMap,
  };
}
