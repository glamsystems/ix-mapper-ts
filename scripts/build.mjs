import { cp, readFile, writeFile } from "node:fs/promises";
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
}

async function bundle(format, outfile) {
  await build({
    entryPoints: ["src/index.ts"],
    outfile,
    bundle: true,
    format,
    platform: "node",
    target: "es2020",
    external,
    sourcemap: false,
    minify: true,
    logLevel: "info",
  });
}

execFileSync(process.execPath, ["scripts/clean.mjs"], { stdio: "inherit" });
await Promise.all([
  bundle("cjs", "index.cjs"),
  bundle("esm", "index.esm.js"),
]);
runTsc();
await copyDeclarations();
