import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLED_TUPLE_ARTIFACTS,
  PUBLICATION_CONTRACT_VERSION,
  assertPackageBoundary,
  hash,
  parseTarball,
  releasePolicy,
  verifyContract,
} from "./publication-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "publication");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ix-mapper-contract-"));

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: path.join(temporaryRoot, "npm-cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  await mkdir(path.join(temporaryRoot, "npm-cache"));
  const packageManifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  assertPackageBoundary(packageManifest);

  const packed = JSON.parse(
    run("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryRoot,
    ]),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error("npm pack must produce exactly one archive");
  }
  const pack = packed[0];
  const archivePath = path.join(temporaryRoot, pack.filename);
  const archive = await readFile(archivePath);
  const members = parseTarball(archive);
  const packedFiles = [...members.entries()]
    .filter(([member]) => member.startsWith("package/"))
    .map(([member, bytes]) => ({
      path: member.slice("package/".length),
      size: bytes.length,
      sha256: hash(bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const forbidden of [
    "index.cjs",
    "index.esm.js",
    "index.esm.mjs",
    "index.cjs.d.ts",
    "index.esm.d.ts",
  ]) {
    if (members.has(`package/${forbidden}`)) {
      throw new Error(`Obsolete legacy-root artifact is packed: ${forbidden}`);
    }
  }
  for (const required of [
    "core.cjs",
    "core.esm.mjs",
    "core.d.ts",
    "legacy-web3.cjs",
    "legacy-web3.esm.mjs",
    "legacy-web3.d.ts",
    "compatibility-manifests/schema-v2.json",
    "operation-profiles-v1/schema-v1.json",
  ]) {
    if (!members.has(`package/${required}`)) {
      throw new Error(`Required publication member is missing: ${required}`);
    }
  }

  const manifestDirectory = path.join(root, "compatibility-manifests/v2");
  const manifestFiles = (await readdir(manifestDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const activeCompatibilityTuples = [];
  for (const file of manifestFiles) {
    const manifestPath = `compatibility-manifests/v2/${file}`;
    const manifestBytes = members.get(`package/${manifestPath}`);
    if (!manifestBytes) {
      throw new Error(`Active manifest is not packed: ${manifestPath}`);
    }
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const artifacts = {};
    for (const name of BUNDLED_TUPLE_ARTIFACTS) {
      const declaration = manifest.artifacts?.[name];
      if (!declaration?.bundled_path) {
        throw new Error(`${manifestPath} does not bundle ${name}`);
      }
      const artifactBytes = members.get(`package/${declaration.bundled_path}`);
      if (!artifactBytes || hash(artifactBytes) !== declaration.sha256) {
        throw new Error(`${manifestPath} has a stale ${name} hash`);
      }
      artifacts[name] = {
        path: declaration.bundled_path,
        sha256: declaration.sha256,
      };
    }
    activeCompatibilityTuples.push({
      integration: manifest.integration,
      variant: manifest.variant,
      status: manifest.status,
      manifestVersion: manifest.manifest_version,
      manifestRevision: manifest.manifest_revision,
      manifest: { path: manifestPath, sha256: hash(manifestBytes) },
      artifacts,
    });
  }

  const policy = releasePolicy(
    packageManifest.version,
    activeCompatibilityTuples.map(({ status }) => status),
  );
  const contract = {
    contractVersion: PUBLICATION_CONTRACT_VERSION,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
    },
    release: policy,
    tarball: {
      filename: pack.filename,
      sha256: hash(archive),
      npmIntegrity: `sha512-${hash(archive, "sha512", "base64")}`,
      members: packedFiles,
    },
    activeCompatibilityTuples,
  };
  verifyContract(contract, archive);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(archivePath, path.join(outputRoot, pack.filename));
  const contractName = `${packageManifest.name
    .replace("@", "")
    .replace("/", "-")}-${packageManifest.version}.publication.json`;
  await writeFile(
    path.join(outputRoot, contractName),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        contract: contractName,
        archive: pack.filename,
        sha256: contract.tarball.sha256,
        members: contract.tarball.members.length,
        maturity: contract.release.maturity,
        distTag: contract.release.distTag,
        defaultPublicDiscovery: contract.release.defaultPublicDiscovery,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
