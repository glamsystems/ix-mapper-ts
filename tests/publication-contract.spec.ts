import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageManifest from "../package.json";
import {
  assertPackageBoundary,
  releasePolicy,
} from "../scripts/publication-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This is deliberately the immediately previous immutable cut. A future recut
// must advance the package version, move this baseline forward to the prior
// cut, and increment every retained manifest's revision exactly once. A newly
// introduced manifest starts at revision 1.
const previousActiveRelease = {
  packageVersion: "0.3.0-test.1",
  manifestRevisions: {
    "jupiter-earn-production.json": 1,
    "jupiter-earn-staging.json": 1,
    "kamino-farms-stake-production.json": 1,
    "kamino-farms-stake-staging.json": 1,
    "kamino-kvaults-production.json": 1,
    "kamino-kvaults-staging.json": 1,
    "kamino-lending-repay-production.json": 1,
    "kamino-lending-repay-staging.json": 1,
  } satisfies Record<string, number>,
};

function nextTestPrerelease(version: string): string {
  const match = /^(.*-test\.)(\d+)$/u.exec(version);
  if (!match) {
    throw new Error(`Previous release is not a test prerelease: ${version}`);
  }
  return `${match[1]}${Number(match[2]) + 1}`;
}

describe("publication maturity boundary", () => {
  it("keeps proof-only tuples on a prerelease test tag", () => {
    expect(releasePolicy("0.3.0-test.2", ["proof-only"])).toEqual({
      maturity: ["proof-only"],
      distTag: "test",
      defaultPublicDiscovery: false,
    });
  });

  it("rejects proof-only tuples from a stable release", () => {
    expect(() => releasePolicy("0.3.0", ["proof-only"])).toThrow(
      "Stable 0.3.0 cannot publish proof-only compatibility manifests",
    );
  });

  it("allows a supported stable tuple into default discovery", () => {
    expect(releasePolicy("1.0.0", ["supported"])).toEqual({
      maturity: ["supported"],
      distTag: "latest",
      defaultPublicDiscovery: true,
    });
  });
});

describe("publication package boundary", () => {
  it("keeps root/core neutral and web3.js optional", () => {
    expect(() => assertPackageBoundary(packageManifest)).not.toThrow();
  });

  it("rejects a legacy package root", () => {
    const legacyRoot = structuredClone(packageManifest);
    legacyRoot.exports["."] = legacyRoot.exports["./legacy-web3"];
    expect(() => assertPackageBoundary(legacyRoot)).toThrow(
      "Package root must expose only the neutral core",
    );
  });
});

describe("active compatibility manifest recut boundary", () => {
  it("increments every retained v2 manifest revision for the next immutable cut", async () => {
    expect(packageManifest.version).toBe(
      nextTestPrerelease(previousActiveRelease.packageVersion),
    );

    const manifestRoot = path.join(root, "compatibility-manifests/v2");
    const manifestFiles = (await readdir(manifestRoot))
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(manifestFiles).toEqual(
      expect.arrayContaining(
        Object.keys(previousActiveRelease.manifestRevisions).sort(),
      ),
    );

    for (const file of manifestFiles) {
      const manifest = JSON.parse(
        await readFile(path.join(manifestRoot, file), "utf8"),
      );
      const previousRevision =
        previousActiveRelease.manifestRevisions[
          file as keyof typeof previousActiveRelease.manifestRevisions
        ];

      expect(manifest.mapper.version, file).toBe(packageManifest.version);
      expect(manifest.status, file).toBe("proof-only");
      expect(manifest.manifest_revision, file).toBe(
        previousRevision === undefined ? 1 : previousRevision + 1,
      );
    }
  });
});
