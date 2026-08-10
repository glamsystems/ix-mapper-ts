import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { verifyContract } from "./publication-contract.mjs";

const contractRoot = path.resolve(process.argv[2] ?? "publication");
const files = await readdir(contractRoot);
const contractFiles = files.filter((file) => file.endsWith(".publication.json"));
if (contractFiles.length !== 1) {
  throw new Error("Expected exactly one publication contract");
}
const contract = JSON.parse(
  await readFile(path.join(contractRoot, contractFiles[0]), "utf8"),
);
const archive = await readFile(
  path.join(contractRoot, contract.tarball.filename),
);

const mutations = [
  {
    name: "status and derived release maturity",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].status = "supported";
      candidate.release.maturity = ["supported"];
    },
  },
  {
    name: "integration identity",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].integration = "other";
    },
  },
  {
    name: "variant identity",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].variant = "staging";
    },
  },
  {
    name: "manifest version",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].manifestVersion += 1;
    },
  },
  {
    name: "manifest revision",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].manifestRevision += 1;
    },
  },
  {
    name: "artifact path",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].artifacts.mapper_config.path =
        candidate.activeCompatibilityTuples[0].artifacts.proxy_idl.path;
    },
  },
  {
    name: "artifact hash",
    mutate(candidate) {
      candidate.activeCompatibilityTuples[0].artifacts.mapper_config.sha256 =
        "0".repeat(64);
    },
  },
];

verifyContract(contract, archive);
for (const { name, mutate } of mutations) {
  const candidate = structuredClone(contract);
  mutate(candidate);
  let rejected = false;
  try {
    verifyContract(candidate, archive);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Publication verifier accepted mutated ${name}`);
  }
}

console.log(
  JSON.stringify(
    {
      archive: contract.tarball.filename,
      adversarialMutationsRejected: mutations.map(({ name }) => name),
    },
    null,
    2,
  ),
);
