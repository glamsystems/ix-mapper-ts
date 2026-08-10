/*
 * Kamino 10 proof harness. This script intentionally installs no candidate in
 * this repository: it extracts the supplied immutable tarball into mkdtemp(),
 * where it resolves its dependencies from the pinned 9.1.5 checkout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import {
  ids,
  canonical,
  depositAccounts,
  withdrawAccounts,
  reservePairs,
  signer,
  helperState,
} from "../tests/fixtures/kamino10-corpus.mjs";

const root = resolve(import.meta.dirname, "..");
const tarball = process.argv[2] ?? "/private/tmp/klend-sdk-10.0.0.tgz";
const sha256 =
  "d375a891eb752b79ad889d1a65a515c8887c17a519548db4d0789aa92a19612d";
const integrity =
  "sha512-U00zrm4jgZzctfGvRZw56kfZUmVXoKtiu9ZaP4CnZ0kg/QdxkyD5TTqJA/v8fThKWr0+uqlCJ6zV+F7QUZl/PA==";
const baselineFiles = [
  "package.json",
  "package-lock.json",
  "compatibility-manifests/v1/kamino-kvaults-production.json",
  "compatibility-manifests/v1/kamino-kvaults-staging.json",
  "artifacts/kamino-kvaults/9.1.5/native-kvault.json",
];

function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}
function requireFrom(dir, path) {
  return createRequire(join(dir, "package.json"))(path);
}
function classify(mapper, ix, context) {
  return mapper.mapInstructionNeutral(ix, context);
}
function vaultFor(state) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    new PublicKey("GLAMpaME8wdTEzxtiYEAa5yD8fZbxZiz2hNtV58RZiEz"),
  )[0].toBase58();
}
function integrationAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("integration-authority")],
    new PublicKey("G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde"),
  )[0].toBase58();
}

async function main() {
  if (process.env.GLAM_ALLOW_NON_PINNED_NODE !== "1") {
    assert.equal(
      process.version,
      "v22.22.0",
      "Kamino 10 Node gate requires exactly Node 22.22.0",
    );
  }
  const before = await Promise.all(
    baselineFiles.map(async (file) => [
      file,
      hash(await readFile(join(root, file))),
    ]),
  );
  const bytes = await readFile(tarball);
  assert.equal(hash(bytes), sha256, "candidate SHA-256");
  assert.equal(
    `sha512-${hash(bytes, "sha512", "base64")}`,
    integrity,
    "candidate npm integrity",
  );
  const members = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.equal(members.length, 3040, "candidate tar member count");
  const packageJson = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.deepEqual(
    {
      name: packageJson.name,
      version: packageJson.version,
      main: packageJson.main,
      exports: packageJson.exports,
      sideEffects: packageJson.sideEffects,
    },
    {
      name: "@kamino-finance/klend-sdk",
      version: "10.0.0",
      main: "dist/index.js",
      exports: undefined,
      sideEffects: undefined,
    },
  );

  const isolated = await mkdtemp(join(tmpdir(), "glam-kamino10-"));
  try {
    const candidate = join(isolated, "node_modules/@kamino-finance/klend-sdk");
    execFileSync("mkdir", ["-p", candidate]);
    execFileSync("tar", [
      "-xzf",
      tarball,
      "-C",
      candidate,
      "--strip-components=1",
    ]);
    // The candidate itself is isolated; its dependency graph is deliberately the
    // checkout's locked 9.1.5 graph, never an npm install or lockfile rewrite.
    await symlink(
      join(root, "node_modules"),
      join(candidate, "node_modules"),
      "dir",
    );
    await writeFile(join(isolated, "package.json"), '{"private":true}\n');
    const base = requireFrom(root, "@kamino-finance/klend-sdk/package.json");
    const next = requireFrom(candidate, "./package.json");
    assert.equal(base.version, "9.1.5");
    assert.equal(next.version, "10.0.0");
    const peerConflicts = [];
    for (const name of [
      "@solana-program/address-lookup-table",
      "@solana-program/system",
      "@solana-program/token",
      "@solana-program/token-2022",
    ]) {
      const peer = JSON.parse(
        await readFile(
          join(root, "node_modules", name, "package.json"),
          "utf8",
        ),
      ).peerDependencies?.["@solana/kit"];
      if (peer?.startsWith("^3"))
        peerConflicts.push(
          `${name} requires ${peer}; candidate declares ${next.dependencies["@solana/kit"]}`,
        );
    }
    assert(
      peerConflicts.length > 0,
      "expected candidate dependency/peer graph conflict was not observed",
    );
    const BN = requireFrom(root, "bn.js");
    const candidateDepositPath = join(
      candidate,
      "dist/@codegen/kvault/instructions/deposit.js",
    );
    const cjsDeposit = requireFrom(
      candidate,
      "./dist/@codegen/kvault/instructions/deposit",
    );
    const esmDeposit = await import(pathToFileURL(candidateDepositPath).href);
    assert.equal(
      typeof cjsDeposit.deposit,
      "function",
      "candidate CJS direct import",
    );
    assert.equal(
      typeof esmDeposit.deposit,
      "function",
      "candidate ESM direct import",
    );
    const glamState = new PublicKey(
      "F9kXvMXF38YbLWjvZ8sdx8B6qJ4gqjCZy1PXnkUDqKFp",
    );
    const glamVault = vaultFor(glamState);
    const fixture = (tokenProgram = ids.token, user = signer()) => ({
      depositAccounts: depositAccounts(user, tokenProgram),
      depositPairs: reservePairs(2),
      withdrawAccounts: withdrawAccounts(user, tokenProgram),
      withdrawPairs: reservePairs(2),
      minAccounts: depositAccounts(user),
      minPairs: reservePairs(1),
      availableAccounts: withdrawAccounts(user).withdrawFromAvailable,
    });
    const pinKvaultAccounts = (input) => {
      const eventAuthority = "24tHwQyJJ9akVXxnvkekGfAoeUJXXS7mE6kQNioNySsK";
      const globalConfig = "BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX";
      input.depositAccounts.eventAuthority = eventAuthority;
      input.minAccounts.eventAuthority = eventAuthority;
      for (const accounts of [
        input.withdrawAccounts.withdrawFromAvailable,
        input.availableAccounts,
      ]) {
        accounts.eventAuthority = eventAuthority;
        accounts.globalConfig = globalConfig;
      }
      input.withdrawAccounts.eventAuthority = eventAuthority;
      return input;
    };
    const build = (sdk, input) => ({
      deposit: sdk.deposit(
        { maxAmount: new BN(123) },
        input.depositAccounts,
        input.depositPairs,
        ids.kvault,
      ),
      withdraw: sdk.withdraw(
        { sharesAmount: new BN(42) },
        input.withdrawAccounts,
        input.withdrawPairs,
        ids.kvault,
      ),
      min: sdk.depositWithMinSharesOut(
        { maxAmount: new BN(123), minSharesOut: new BN(1) },
        input.minAccounts,
        input.minPairs,
        ids.kvault,
      ),
      available: sdk.withdrawFromAvailable(
        { sharesAmount: new BN(42) },
        input.availableAccounts,
        [],
        ids.kvault,
      ),
    });
    const load = (dir) => ({
      deposit: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/kvault/instructions/deposit"
          : "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/deposit",
      ).deposit,
      withdraw: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/kvault/instructions/withdraw"
          : "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdraw",
      ).withdraw,
      depositWithMinSharesOut: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/kvault/instructions/depositWithMinSharesOut"
          : "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/depositWithMinSharesOut",
      ).depositWithMinSharesOut,
      withdrawFromAvailable: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/kvault/instructions/withdrawFromAvailable"
          : "@kamino-finance/klend-sdk/dist/@codegen/kvault/instructions/withdrawFromAvailable",
      ).withdrawFromAvailable,
    });
    // Builders are compared structurally rather than with random address values.
    for (const tokenProgram of [ids.token, ids.token2022]) {
      const input = pinKvaultAccounts(fixture(tokenProgram));
      const a = build(load(root), input),
        b = build(load(candidate), input);
      for (const name of Object.keys(a)) {
        assert.deepEqual(
          canonical(a[name]),
          canonical(b[name]),
          `${name} exact instruction`,
        );
      }
    }
    const kit = requireFrom(root, "@solana/kit");
    const loadKlend = (dir) => ({
      refreshReserve: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/klend/instructions/refreshReserve"
          : "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/refreshReserve",
      ).refreshReserve,
      refreshObligation: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/klend/instructions/refreshObligation"
          : "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/refreshObligation",
      ).refreshObligation,
      repay: requireFrom(
        dir,
        dir === candidate
          ? "./dist/@codegen/klend/instructions/repayObligationLiquidityV2"
          : "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/repayObligationLiquidityV2",
      ).repayObligationLiquidityV2,
    });
    const market = canonicalAddress(),
      obligation = canonicalAddress(),
      depositReserve = canonicalAddress(),
      otherBorrowReserve = canonicalAddress(),
      repayReserve = canonicalAddress(),
      pyth = canonicalAddress(),
      reserveMint = canonicalAddress(),
      reserveSupply = canonicalAddress(),
      userSource = canonicalAddress(),
      marketAuthority = canonicalAddress();
    function canonicalAddress() {
      return new PublicKey(PublicKey.unique()).toBase58();
    }
    const buildKlend = (sdk) => [
      sdk.refreshReserve(
        {
          reserve: depositReserve,
          lendingMarket: market,
          pythOracle: kit.some(pyth),
          switchboardPriceOracle: kit.none(),
          switchboardTwapOracle: kit.none(),
          scopePrices: kit.none(),
        },
        [],
        ids.klend,
      ),
      sdk.refreshReserve(
        {
          reserve: otherBorrowReserve,
          lendingMarket: market,
          pythOracle: kit.none(),
          switchboardPriceOracle: kit.none(),
          switchboardTwapOracle: kit.none(),
          scopePrices: kit.none(),
        },
        [],
        ids.klend,
      ),
      sdk.refreshReserve(
        {
          reserve: repayReserve,
          lendingMarket: market,
          pythOracle: kit.none(),
          switchboardPriceOracle: kit.none(),
          switchboardTwapOracle: kit.none(),
          scopePrices: kit.none(),
        },
        [],
        ids.klend,
      ),
      sdk.refreshObligation(
        { lendingMarket: market, obligation },
        [depositReserve, otherBorrowReserve, repayReserve].map((address) => ({
          address,
          role: 1,
        })),
        ids.klend,
      ),
      sdk.repay(
        { liquidityAmount: new BN(123_456) },
        {
          repayAccounts: {
            owner: { address: glamVault },
            obligation,
            lendingMarket: market,
            repayReserve,
            reserveLiquidityMint: reserveMint,
            reserveDestinationLiquidity: reserveSupply,
            userSourceLiquidity: userSource,
            tokenProgram: ids.token,
            instructionSysvarAccount: ids.instructionsSysvar,
          },
          farmsAccounts: {
            obligationFarmUserState: kit.none(),
            reserveFarmState: kit.none(),
          },
          lendingMarketAuthority: marketAuthority,
          farmsProgram: ids.farms,
        },
        [],
        ids.klend,
      ),
    ];
    const baseKlend = buildKlend(loadKlend(root));
    const candidateKlend = buildKlend(loadKlend(candidate));
    assert.equal(baseKlend.length, 5, "bounded Klend helper corpus size");
    for (let index = 0; index < baseKlend.length; index += 1) {
      assert.deepEqual(
        canonical(baseKlend[index]),
        canonical(candidateKlend[index]),
        `Klend repay corpus instruction ${String(index)}`,
      );
    }
    const [baseAction, candidateAction] = await Promise.all([
      readFile(
        join(
          root,
          "node_modules/@kamino-finance/klend-sdk/dist/classes/action.js",
        ),
      ),
      readFile(join(candidate, "dist/classes/action.js")),
    ]);
    assert.equal(
      hash(baseAction),
      hash(candidateAction),
      "KaminoAction helper source must remain byte-identical",
    );
    const mapper = requireFrom(root, "./core.cjs");
    const { createNeutralMapper } = mapper;
    const esmCore = await import(
      pathToFileURL(join(root, "core.esm.mjs")).href
    );
    assert.equal(
      typeof esmCore.createNeutralMapper,
      "function",
      "packed neutral ESM import",
    );
    // Consume the actual npm tarball in a separate temporary package tree.
    const packEnv = { ...process.env };
    for (const key of Object.keys(packEnv)) {
      if (key.toLowerCase() === "npm_config_dry_run") delete packEnv[key];
    }
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", isolated],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...packEnv,
            NPM_CONFIG_CACHE: join(isolated, "npm-cache"),
          },
        },
      ),
    )[0];
    const consumerPackage = join(
      isolated,
      "consumer/node_modules/@glamsystems/ix-mapper",
    );
    execFileSync("mkdir", ["-p", consumerPackage]);
    execFileSync("tar", [
      "-xzf",
      join(isolated, packed.filename),
      "-C",
      consumerPackage,
      "--strip-components=1",
    ]);
    await symlink(
      join(root, "node_modules"),
      join(consumerPackage, "node_modules"),
      "dir",
    );
    const packedCore = requireFrom(
      join(isolated, "consumer"),
      "@glamsystems/ix-mapper/core",
    );
    const packedEsmCore = await import(
      pathToFileURL(join(consumerPackage, "core.esm.mjs")).href
    );
    assert.equal(
      typeof packedCore.createNeutralMapper,
      "function",
      "packed neutral CJS consumer import",
    );
    assert.equal(
      typeof packedEsmCore.createNeutralMapper,
      "function",
      "packed neutral ESM consumer import",
    );
    const core = createNeutralMapper({ normalizeAddress: (value) => value });
    const context = {
      glamStateAddress: glamState.toBase58(),
      glamVaultAddress: glamVault,
      glamSignerAddress: "8M5XgZWZWxGLDvJgXrv4b8ZFQT5BT8qjN5hPvVm4Cyqg",
      integrationAuthorityByProxyProgram: {
        G1NTkDEUR3pkEqGCKZtmtmVzCUEdYa86pezHkwYbLyde: integrationAuthority(),
      },
    };
    // Classification oracle: direct positive builders must map; explicit alternatives must fail closed.
    const candidateBuilt = build(
      load(candidate),
      pinKvaultAccounts(fixture(ids.token, { address: glamVault })),
    );
    const mappedDeposit = classify(core, candidateBuilt.deposit, context);
    const mappedWithdraw = classify(core, candidateBuilt.withdraw, context);
    assert.equal(mappedDeposit.kind, "mapped", JSON.stringify(mappedDeposit));
    assert.equal(mappedWithdraw.kind, "mapped", JSON.stringify(mappedWithdraw));
    assert.equal(
      classify(core, candidateBuilt.min, context).kind,
      "unsupported",
    );
    assert.equal(
      classify(core, candidateBuilt.available, context).kind,
      "unsupported",
    );
    const operation = core.mapInstructionsNeutral(
      [candidateBuilt.deposit, candidateBuilt.min],
      context,
    );
    assert(
      operation.some(({ kind }) => kind === "unsupported"),
      "unsupported instruction must abort complete operation",
    );
    // High-level deposit is run directly; it must retain the unsupported ATA before its mapped KVault deposit.
    const { KaminoVaultClient } = requireFrom(
      candidate,
      "./dist/classes/vault",
    );
    const Decimal = requireFrom(root, "decimal.js");
    for (const tokenProgram of [ids.token, ids.token2022]) {
      const high = helperState(BN, tokenProgram, 1);
      const emitted = await new KaminoVaultClient({}).depositIxs(
        { address: glamVault },
        high.vault,
        new Decimal(7),
        high.reserveMap,
        null,
        null,
      );
      assert.equal(
        emitted.depositIxs.length,
        2,
        "deposit helper emission count",
      );
      assert.equal(
        emitted.depositIxs[0].programAddress,
        ids.ata,
        "deposit helper emits idempotent shares ATA first",
      );
      assert.equal(
        emitted.depositIxs[1].programAddress,
        ids.kvault,
        "deposit helper emits KVault deposit second",
      );
      const results = core.mapInstructionsNeutral(emitted.depositIxs, context);
      assert.equal(results[0].kind, "unsupported");
      assert.equal(results[1].kind, "mapped");
    }
    // Withdrawal uses state-only seams for the user-share read and liquidity plan. The SDK still constructs every ATA/KVault instruction.
    const high = helperState(BN, ids.token, 2);
    const highClient = new KaminoVaultClient({});
    highClient.getUserSharesState = async () => ({
      userSharesAta: ids.system,
      ataBalance: new Decimal(100),
      farmBalance: new Decimal(0),
      totalShares: new Decimal(100),
    });
    highClient.getTokensPerShareSingleVault = async () => new Decimal(1);
    highClient.getShareExitLiquidityPlan = async () => ({
      shareLamportsToWithdraw: new Decimal(10),
      grossTokenLamportsToWithdraw: new Decimal(10),
      netTokenLamportsToWithdraw: new Decimal(10),
      availableTokenLamportsToWithdraw: new Decimal(0),
      reserveTokenLamportsToWithdraw: new Map(
        [...high.reserveMap.keys()].map((reserve) => [reserve, new Decimal(5)]),
      ),
      remainingNetTokenLamportsToWithdraw: new Decimal(0),
      burnAllUserShares: false,
      canBurnAllUserShares: false,
    });
    const withdrawal = await highClient.withdrawIxs(
      { address: glamVault },
      high.vault,
      new Decimal(10),
      1n,
      high.reserveMap,
      null,
      null,
      undefined,
      {},
    );
    assert.equal(
      withdrawal.withdrawIxs.length,
      3,
      "multiple-reserve helper emits one ATA then two withdraws",
    );
    assert.equal(withdrawal.withdrawIxs[0].programAddress, ids.ata);
    assert(
      withdrawal.withdrawIxs
        .slice(1)
        .every((ix) => ix.programAddress === ids.kvault),
    );
    const withdrawalResults = core.mapInstructionsNeutral(
      withdrawal.withdrawIxs,
      context,
    );
    assert.equal(withdrawalResults[0].kind, "unsupported");
    assert(withdrawalResults.slice(1).every(({ kind }) => kind === "mapped"));
    // These source sentinels make all intentionally unsupported helper branches review obligations, not bypasses.
    const vaultSource = await readFile(
      join(candidate, "dist/classes/vault.js"),
      "utf8",
    );
    for (const token of [
      "createAtasIdempotent",
      "getTransferWsolIxs",
      "depositWithMinSharesOut",
      "getAddMemoInstruction",
      "stakeSharesIxs",
      "buildFarmUnstakeIxsIfNeeded",
      "withdrawFromAvailableIxs",
      "getCloseAccountInstruction",
      "buildReserveExitIxs",
    ])
      assert(vaultSource.includes(token), `missing high-level branch ${token}`);
    const after = await Promise.all(
      baselineFiles.map(async (file) => [
        file,
        hash(await readFile(join(root, file))),
      ]),
    );
    assert.deepEqual(after, before, "baseline tuple mutated");
    console.log(
      JSON.stringify(
        {
          node: process.version,
          tarball: { sha256, integrity, members: members.length },
          generatedBuilderDifferential: "passed",
          highLevelBranchInventory: "passed",
          classification: "fail-closed",
          packedNeutralConsumer: "passed",
          dependencyPeerGraph: { status: "blocked", peerConflicts },
          baselineImmutability: "passed",
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
