import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "ix-mapper-packed-consumer-"),
);

function childEnvironment() {
  const env = {
    ...process.env,
    NPM_CONFIG_CACHE: path.join(temporaryRoot, "npm-cache"),
  };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "npm_config_dry_run") delete env[key];
  }
  return env;
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function probe(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: childEnvironment(),
  });
}

try {
  const archiveRoot = path.join(temporaryRoot, "archive");
  const consumerRoot = path.join(temporaryRoot, "consumer");
  await mkdir(archiveRoot);
  await mkdir(consumerRoot);
  await mkdir(path.join(temporaryRoot, "npm-cache"));

  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", archiveRoot],
      packageRoot,
    ),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error("Packed mapper output must identify exactly one archive");
  }
  const archivePath = path.join(archiveRoot, packed[0].filename);
  const members = run("tar", ["-tzf", archivePath], packageRoot)
    .trim()
    .split("\n");
  for (const required of [
    "package/core.cjs",
    "package/core.esm.mjs",
    "package/core.d.ts",
    "package/legacy-web3.cjs",
    "package/legacy-web3.esm.mjs",
    "package/legacy-web3.d.ts",
    "package/operation-profiles-v1/schema-v1.json",
    "package/operation-profiles-v1/kamino-kvaults.json",
    "package/operation-profiles-v2/schema-v2.json",
    "package/operation-profiles-v2/kamino-lending-repay.json",
    "package/operation-profiles-v2/kamino-farms-stake.json",
    "package/artifacts/kamino-farms/1.6.5/native-farms.json",
    "package/compatibility-manifests/schema-v2.json",
    "package/compatibility-manifests/v2/kamino-kvaults-production.json",
    "package/compatibility-manifests/v2/kamino-kvaults-staging.json",
    "package/compatibility-manifests/v2/kamino-lending-repay-production.json",
    "package/compatibility-manifests/v2/kamino-lending-repay-staging.json",
    "package/compatibility-manifests/v2/kamino-farms-stake-production.json",
    "package/compatibility-manifests/v2/kamino-farms-stake-staging.json",
  ]) {
    if (!members.includes(required)) {
      throw new Error(`Packed mapper artifact is missing ${required}`);
    }
  }

  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@glamsystems/ix-mapper": `file:${archivePath}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  run(
    "npm",
    [
      "install",
      "--offline",
      "--omit=peer",
      "--ignore-scripts",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
    ],
    consumerRoot,
  );

  await writeFile(
    path.join(consumerRoot, "probe.mjs"),
    `import { createRequire } from "node:module";\n` +
      `import { createNeutralMapper as rootMapper } from "@glamsystems/ix-mapper";\n` +
      `import { createNeutralMapper as coreMapper } from "@glamsystems/ix-mapper/core";\n` +
      `if (rootMapper !== coreMapper) throw new Error("root/core export mismatch");\n` +
      `const require = createRequire(import.meta.url);\n` +
      `try { require.resolve("@solana/web3.js"); throw new Error("neutral install contains web3.js"); } catch (error) { if (error?.code !== "MODULE_NOT_FOUND") throw error; }\n` +
      `const profile = await import("@glamsystems/ix-mapper/operation-profiles-v1/kamino-kvaults.json", { with: { type: "json" } });\n` +
      `if (profile.default.operations.length !== 2) throw new Error("operation profile export drift");\n` +
      `const klend = await import("@glamsystems/ix-mapper/operation-profiles-v2/kamino-lending-repay.json", { with: { type: "json" } });\n` +
      `if (klend.default.operations.length !== 1 || klend.default.schema_version !== 2) throw new Error("Klend operation profile export drift");\n` +
      `const farms = await import("@glamsystems/ix-mapper/operation-profiles-v2/kamino-farms-stake.json", { with: { type: "json" } });\n` +
      `if (farms.default.operations.length !== 2 || farms.default.schema_version !== 2) throw new Error("Farms operation profile export drift");\n` +
      `const mapper = rootMapper({ normalizeAddress: value => value }); if (typeof mapper.mapKaminoFarmsStakeOperationNeutral !== "function") throw new Error("Farms mapper export missing");\n`,
  );
  run(process.execPath, ["probe.mjs"], consumerRoot);
  run(
    process.execPath,
    [
      "-e",
      `const root=require("@glamsystems/ix-mapper"); const core=require("@glamsystems/ix-mapper/core"); if(root.createNeutralMapper!==core.createNeutralMapper) throw new Error("CJS root/core export mismatch");`,
    ],
    consumerRoot,
  );
  for (const mode of [
    [
      "--input-type=module",
      "-e",
      'await import("@glamsystems/ix-mapper/legacy-web3")',
    ],
    ["-e", 'require("@glamsystems/ix-mapper/legacy-web3")'],
  ]) {
    const missingPeer = probe(process.execPath, mode, consumerRoot);
    const output = `${missingPeer.stdout ?? ""}\n${missingPeer.stderr ?? ""}`;
    if (missingPeer.status === 0 || !output.includes("@solana/web3.js")) {
      throw new Error(
        "Legacy entrypoint without its optional peer must fail explicitly on @solana/web3.js",
      );
    }
  }

  const pinnedWeb3Manifest = JSON.parse(
    await readFile(
      path.join(packageRoot, "node_modules/@solana/web3.js/package.json"),
      "utf8",
    ),
  );
  if (pinnedWeb3Manifest.version !== "1.98.4") {
    throw new Error(
      "Legacy packed-consumer peer is not pinned to web3.js 1.98.4",
    );
  }
  const solanaScope = path.join(consumerRoot, "node_modules/@solana");
  await mkdir(solanaScope, { recursive: true });
  await symlink(
    path.join(packageRoot, "node_modules/@solana/web3.js"),
    path.join(solanaScope, "web3.js"),
    "dir",
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const legacy=await import("@glamsystems/ix-mapper/legacy-web3"); for(const name of ["mapInstruction","mapInstructions","mapToGlamIx","fixSignerAccounts","normalizeInstruction"]) if(typeof legacy[name]!=="function") throw new Error(name);`,
    ],
    consumerRoot,
  );
  run(
    process.execPath,
    [
      "-e",
      `const legacy=require("@glamsystems/ix-mapper/legacy-web3"); if(typeof legacy.mapInstruction!=="function") throw new Error("CJS legacy export missing");`,
    ],
    consumerRoot,
  );

  const installedManifest = JSON.parse(
    await readFile(
      path.join(
        consumerRoot,
        "node_modules/@glamsystems/ix-mapper/package.json",
      ),
      "utf8",
    ),
  );
  if (
    installedManifest.dependencies?.["@solana/web3.js"] !== undefined ||
    installedManifest.peerDependenciesMeta?.["@solana/web3.js"]?.optional !==
      true
  ) {
    throw new Error("Packed mapper web3.js boundary is not optional-peer only");
  }

  console.log(
    JSON.stringify(
      {
        archive: packed[0].filename,
        files: packed[0].entryCount,
        neutralRoot: true,
        web3Installed: false,
        legacyMissingPeerFailure: true,
        legacyWithPinnedPeer: pinnedWeb3Manifest.version,
        operationProfiles: 5,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
