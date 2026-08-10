import packageManifest from "../package.json";
import {
  assertPackageBoundary,
  releasePolicy,
} from "../scripts/publication-contract.mjs";

describe("publication maturity boundary", () => {
  it("keeps proof-only tuples on a prerelease test tag", () => {
    expect(releasePolicy("0.3.0-test.1", ["proof-only"])).toEqual({
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
