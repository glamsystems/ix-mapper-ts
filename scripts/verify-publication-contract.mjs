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
const { members, policy } = verifyContract(contract, archive);

console.log(
  JSON.stringify(
    {
      package: `${contract.package.name}@${contract.package.version}`,
      archive: contract.tarball.filename,
      sha256: contract.tarball.sha256,
      members: members.size,
      maturity: policy.maturity,
      distTag: policy.distTag,
      defaultPublicDiscovery: policy.defaultPublicDiscovery,
      compatibilityTuples: contract.activeCompatibilityTuples.length,
    },
    null,
    2,
  ),
);
