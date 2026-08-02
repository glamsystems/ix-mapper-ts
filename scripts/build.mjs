import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { build } from "esbuild";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const externalPackages = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
];
const external = externalPackages.flatMap((name) => [name, `${name}/*`]);

function runTsc() {
  const tsc = join("node_modules", ".bin", "tsc");
  execFileSync(tsc, ["-p", "tsconfig.build.json"], { stdio: "inherit" });
}

async function copyDeclarations() {
  await cp(".build/types/src", "src", { recursive: true });

  const entryDeclaration = 'export * from "./src/index";\n';
  await writeFile("index.cjs.d.ts", entryDeclaration);
  await writeFile("index.esm.d.ts", entryDeclaration);
  await writeFile("legacy-web3.d.ts", entryDeclaration);
  await writeFile("core.d.ts", 'export * from "./src/core";\n');
}

async function bundle(entryPoint, format, outfile, platform = "node") {
  return build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format,
    platform,
    target: "es2020",
    external,
    metafile: true,
    sourcemap: false,
    minify: true,
    logLevel: "info",
  });
}

function assertNeutralBundle(result, label) {
  const forbidden = ["@solana/web3.js", "@solana/kit", "@coral-xyz/anchor"];
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  const imports = Object.values(result.metafile?.outputs ?? {}).flatMap(
    (output) => output.imports.map(({ path }) => path),
  );
  for (const dependency of forbidden) {
    if (
      inputs.some((input) => input.includes(dependency)) ||
      imports.some((path) => path.includes(dependency))
    ) {
      throw new Error(`${label} unexpectedly references ${dependency}`);
    }
  }
}

async function assertNeutralOutput(file) {
  const source = await readFile(file, "utf8");
  for (const forbidden of [
    "@solana/web3.js",
    "@solana/kit",
    "@coral-xyz/anchor",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`${file} unexpectedly bundles ${forbidden}`);
    }
  }
  if (/\bBuffer\b|\bnode:/.test(source)) {
    throw new Error(`${file} unexpectedly depends on a Node-only runtime API`);
  }
}

async function assertNeutralDeclarations() {
  const files = [
    "core.d.ts",
    "src/core.d.ts",
    "src/core-types.d.ts",
    "src/neutral.d.ts",
    "src/strict.d.ts",
  ];
  const forbidden = ["@solana/web3.js", "@solana/kit", "@coral-xyz/anchor"];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const dependency of forbidden) {
      if (source.includes(dependency)) {
        throw new Error(`${file} unexpectedly references ${dependency}`);
      }
    }
  }
}

execFileSync(process.execPath, ["scripts/clean.mjs"], { stdio: "inherit" });
const [, , , , coreCjs, coreEsm] = await Promise.all([
  bundle("src/index.ts", "cjs", "index.cjs"),
  bundle("src/index.ts", "esm", "index.esm.mjs"),
  bundle("src/index.ts", "cjs", "legacy-web3.cjs"),
  bundle("src/index.ts", "esm", "legacy-web3.esm.mjs"),
  bundle("src/core.ts", "cjs", "core.cjs", "neutral"),
  bundle("src/core.ts", "esm", "core.esm.mjs", "neutral"),
]);
assertNeutralBundle(coreCjs, "core.cjs");
assertNeutralBundle(coreEsm, "core.esm.mjs");
await assertNeutralOutput("core.cjs");
await assertNeutralOutput("core.esm.mjs");
await copyFile("index.esm.mjs", "index.esm.js");
runTsc();
await copyDeclarations();
await assertNeutralDeclarations();
