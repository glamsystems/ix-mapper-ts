import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "publication-matrix");

async function findContracts(directory) {
  const contracts = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      contracts.push(...(await findContracts(entryPath)));
    } else if (entry.name.endsWith(".publication.json")) {
      contracts.push(entryPath);
    }
  }
  return contracts;
}

const contractPaths = (await findContracts(root)).sort();
if (contractPaths.length < 2) {
  throw new Error("Reproducibility requires at least two publication contracts");
}
const contracts = await Promise.all(
  contractPaths.map(async (contractPath) => ({
    contractPath: path.relative(root, contractPath),
    contract: JSON.parse(await readFile(contractPath, "utf8")),
  })),
);
const baseline = contracts[0].contract;
for (const { contractPath, contract } of contracts.slice(1)) {
  if (
    contract.package.name !== baseline.package.name ||
    contract.package.version !== baseline.package.version ||
    contract.tarball.sha256 !== baseline.tarball.sha256 ||
    contract.tarball.npmIntegrity !== baseline.tarball.npmIntegrity
  ) {
    throw new Error(`Publication output is not reproducible: ${contractPath}`);
  }
}

console.log(
  JSON.stringify(
    {
      package: `${baseline.package.name}@${baseline.package.version}`,
      sha256: baseline.tarball.sha256,
      contracts: contracts.map(({ contractPath }) => contractPath),
    },
    null,
    2,
  ),
);
