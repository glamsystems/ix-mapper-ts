import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const rootFiles = [
  ".build",
  "core.cjs",
  "core.esm.mjs",
  "core.esm.js",
  "core.d.ts",
  "index.cjs",
  "index.esm.mjs",
  "index.esm.js",
  "index.cjs.d.ts",
  "index.esm.d.ts",
  "legacy-web3.cjs",
  "legacy-web3.esm.mjs",
  "legacy-web3.esm.js",
  "legacy-web3.d.ts",
];

async function removeDtsFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await removeDtsFiles(path);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        await rm(path, { force: true });
      }
    }),
  );
}

await Promise.all(
  rootFiles.map((path) => rm(path, { recursive: true, force: true })),
);
await removeDtsFiles("src");
