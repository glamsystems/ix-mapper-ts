import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const PUBLICATION_CONTRACT_VERSION = 1;
export const BUNDLED_TUPLE_ARTIFACTS = Object.freeze([
  "native_idl",
  "proxy_idl",
  "mapper_config",
  "instruction_classification_schema",
  "instruction_classification_config",
  "operation_profile_schema",
  "operation_profile_config",
]);

export function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

export function parseTarball(tarball) {
  const archive = gunzipSync(tarball);
  const members = new Map();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const readString = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/u, "");
    const name = readString(0, 100);
    const prefix = readString(345, 500);
    const memberName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readString(124, 136).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar member size for ${memberName}`);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new Error(`Truncated tar member: ${memberName}`);
    }
    if (members.has(memberName)) {
      throw new Error(`Duplicate tar member: ${memberName}`);
    }
    members.set(memberName, archive.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return members;
}

export function assertPackageBoundary(packageManifest) {
  const root = packageManifest.exports?.["."];
  const core = packageManifest.exports?.["./core"];
  const legacy = packageManifest.exports?.["./legacy-web3"];
  const expectedCore = {
    types: "./core.d.ts",
    import: "./core.esm.mjs",
    require: "./core.cjs",
  };
  const expectedLegacy = {
    types: "./legacy-web3.d.ts",
    import: "./legacy-web3.esm.mjs",
    require: "./legacy-web3.cjs",
  };

  if (JSON.stringify(root) !== JSON.stringify(expectedCore)) {
    throw new Error("Package root must expose only the neutral core");
  }
  if (JSON.stringify(core) !== JSON.stringify(expectedCore)) {
    throw new Error("The /core export must equal the neutral package root");
  }
  if (JSON.stringify(legacy) !== JSON.stringify(expectedLegacy)) {
    throw new Error("The /legacy-web3 export is not isolated correctly");
  }
  if (
    packageManifest.main !== expectedCore.require ||
    packageManifest.module !== expectedCore.import ||
    packageManifest.types !== expectedCore.types
  ) {
    throw new Error("Legacy package fields must resolve to the neutral core");
  }
  if (packageManifest.dependencies?.["@solana/web3.js"] !== undefined) {
    throw new Error("web3.js cannot be a mapper runtime dependency");
  }
  if (
    packageManifest.peerDependencies?.["@solana/web3.js"] === undefined ||
    packageManifest.peerDependenciesMeta?.["@solana/web3.js"]?.optional !== true
  ) {
    throw new Error("web3.js must remain an optional legacy-only peer");
  }
}

export function releasePolicy(packageVersion, statuses) {
  const uniqueStatuses = [...new Set(statuses)].sort();
  if (uniqueStatuses.length === 0) {
    throw new Error("At least one active compatibility manifest is required");
  }

  const prerelease = packageVersion.includes("-");
  const proofOnly = uniqueStatuses.includes("proof-only");
  if (proofOnly && !prerelease) {
    throw new Error(
      `Stable ${packageVersion} cannot publish proof-only compatibility manifests`,
    );
  }

  return {
    maturity: uniqueStatuses,
    distTag: prerelease ? "test" : "latest",
    defaultPublicDiscovery: !prerelease && !proofOnly,
  };
}

export function verifyContract(contract, tarball) {
  if (contract.contractVersion !== PUBLICATION_CONTRACT_VERSION) {
    throw new Error("Unknown publication contract version");
  }
  if (
    typeof contract.package?.name !== "string" ||
    typeof contract.package?.version !== "string"
  ) {
    throw new Error("Publication contract package tuple is incomplete");
  }
  const members = parseTarball(tarball);
  const archiveSha256 = hash(tarball);
  const archiveIntegrity = `sha512-${hash(tarball, "sha512", "base64")}`;
  if (
    contract.tarball.sha256 !== archiveSha256 ||
    contract.tarball.npmIntegrity !== archiveIntegrity
  ) {
    throw new Error("Publication tarball digest does not match its contract");
  }
  if (members.size !== contract.tarball.members.length) {
    throw new Error("Publication tarball member count drift");
  }

  const expectedMemberPaths = new Set(
    contract.tarball.members.map(({ path: memberPath }) => memberPath),
  );
  if (expectedMemberPaths.size !== contract.tarball.members.length) {
    throw new Error("Publication contract contains duplicate members");
  }
  for (const member of members.keys()) {
    if (
      !member.startsWith("package/") ||
      !expectedMemberPaths.has(member.slice("package/".length))
    ) {
      throw new Error(`Publication contract does not exhaust ${member}`);
    }
  }
  for (const expected of contract.tarball.members) {
    const bytes = members.get(`package/${expected.path}`);
    if (!bytes) {
      throw new Error(`Publication tarball is missing ${expected.path}`);
    }
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) {
      throw new Error(`Publication tarball member drift: ${expected.path}`);
    }
  }

  const packedManifestBytes = members.get("package/package.json");
  if (!packedManifestBytes) {
    throw new Error("Publication tarball has no package.json");
  }
  const packedManifest = JSON.parse(packedManifestBytes.toString("utf8"));
  assertPackageBoundary(packedManifest);
  if (
    packedManifest.name !== contract.package.name ||
    packedManifest.version !== contract.package.version
  ) {
    throw new Error("Publication package tuple does not match the tarball");
  }

  const policy = releasePolicy(
    contract.package.version,
    contract.activeCompatibilityTuples.map(({ status }) => status),
  );
  if (
    JSON.stringify(policy.maturity) !==
      JSON.stringify(contract.release.maturity) ||
    policy.distTag !== contract.release.distTag ||
    policy.defaultPublicDiscovery !== contract.release.defaultPublicDiscovery
  ) {
    throw new Error("Publication maturity boundary drift");
  }

  const packedActiveManifests = [...members.keys()]
    .filter(
      (member) =>
        member.startsWith("package/compatibility-manifests/v2/") &&
        member.endsWith(".json"),
    )
    .map((member) => member.slice("package/".length))
    .sort();
  const contractedActiveManifests = contract.activeCompatibilityTuples
    .map(({ manifest }) => manifest.path)
    .sort();
  if (
    JSON.stringify(packedActiveManifests) !==
    JSON.stringify(contractedActiveManifests)
  ) {
    throw new Error("Publication contract does not exhaust active manifests");
  }
  for (const tuple of contract.activeCompatibilityTuples) {
    const manifest = members.get(`package/${tuple.manifest.path}`);
    if (!manifest || hash(manifest) !== tuple.manifest.sha256) {
      throw new Error(`Compatibility manifest drift: ${tuple.manifest.path}`);
    }
    if (
      JSON.stringify(Object.keys(tuple.artifacts).sort()) !==
      JSON.stringify([...BUNDLED_TUPLE_ARTIFACTS].sort())
    ) {
      throw new Error(
        `Compatibility tuple artifact inventory drift: ${tuple.manifest.path}`,
      );
    }
    for (const artifact of Object.values(tuple.artifacts)) {
      const bundled = members.get(`package/${artifact.path}`);
      if (!bundled || hash(bundled) !== artifact.sha256) {
        throw new Error(`Compatibility artifact drift: ${artifact.path}`);
      }
    }
  }

  return { members, policy };
}
