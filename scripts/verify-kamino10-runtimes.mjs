import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const expectedNode = "v22.22.0";
const expectedTarballSha256 =
  "d375a891eb752b79ad889d1a65a515c8887c17a519548db4d0789aa92a19612d";
const tarball = process.argv[2];
const nextProjectRoot = process.env.GLAM_NEXT_PROJECT_ROOT;
const expoProjectRoot = process.env.GLAM_EXPO_PROJECT_ROOT;

if (process.version !== expectedNode) {
  throw new Error(`Kamino 10 runtime gate requires ${expectedNode}`);
}
if (!tarball || !nextProjectRoot || !expoProjectRoot) {
  throw new Error(
    "Usage: GLAM_NEXT_PROJECT_ROOT=<web> GLAM_EXPO_PROJECT_ROOT=<mobile> node verify-kamino10-runtimes.mjs <tarball>",
  );
}

const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "kamino10-runtime-gates-"),
);
const candidateRoot = path.join(
  temporaryRoot,
  "candidate/node_modules/@kamino-finance/klend-sdk",
);
const mapperRoot = path.resolve(import.meta.dirname, "..");

function command(executable, args, cwd, environment = process.env) {
  return spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
}

function detail(result) {
  return {
    exitCode: result.status,
    ...(result.hermesExitCode === undefined
      ? {}
      : { hermesExitCode: result.hermesExitCode }),
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .replaceAll(/\u001b\[[0-9;]*m/gu, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-12),
  };
}

async function writeNextProbe(root, importPath) {
  await mkdir(path.join(root, "app"), { recursive: true });
  await symlink(
    path.join(nextProjectRoot, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await writeFile(
    path.join(root, "package.json"),
    '{"private":true,"type":"module","scripts":{"build":"next build"}}\n',
  );
  await writeFile(
    path.join(root, "app/layout.jsx"),
    "export default function Layout({children}) { return <html><body>{children}</body></html>; }\n",
  );
  await writeFile(
    path.join(root, "app/page.jsx"),
    `"use client";\nimport candidate from ${JSON.stringify(importPath)};\nexport default function Page() { return <main>{typeof candidate}</main>; }\n`,
  );
}

async function runNextProbe(name, importPath) {
  const root = path.join(temporaryRoot, `next-${name}`);
  await writeNextProbe(root, importPath);
  const requireFromNext = createRequire(
    path.join(nextProjectRoot, "package.json"),
  );
  const nextBin = requireFromNext.resolve("next/dist/bin/next");
  return command(process.execPath, [nextBin, "build"], root, {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
  });
}

async function writeExpoProbe(root, importPath) {
  await mkdir(root, { recursive: true });
  await symlink(
    path.join(expoProjectRoot, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await writeFile(
    path.join(root, "package.json"),
    '{"private":true,"main":"entry.js"}\n',
  );
  await writeFile(
    path.join(root, "app.json"),
    '{"expo":{"name":"kamino-runtime-probe","slug":"kamino-runtime-probe"}}\n',
  );
  await writeFile(
    path.join(root, "entry.js"),
    `const candidate = require(${JSON.stringify(importPath)});\nglobalThis.__kaminoRuntimeProbe = typeof candidate;\n`,
  );
  await writeFile(
    path.join(root, "metro.config.cjs"),
    `const path = require("node:path");\n` +
      `const { getDefaultConfig } = require("expo/metro-config");\n` +
      `const config = getDefaultConfig(__dirname);\n` +
      `config.watchFolders = [${JSON.stringify(candidateRoot)}, ${JSON.stringify(path.join(mapperRoot, "node_modules"))}, ${JSON.stringify(path.resolve(expoProjectRoot, "../node_modules"))}];\n` +
      `config.resolver.unstable_enableSymlinks = true;\n` +
      `config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules"), ${JSON.stringify(path.resolve(expoProjectRoot, "../node_modules"))}, ${JSON.stringify(path.join(mapperRoot, "node_modules"))}];\n` +
      `module.exports = config;\n`,
  );
}

async function runExpoProbe(name, importPath) {
  const root = path.join(temporaryRoot, `expo-${name}`);
  await writeExpoProbe(root, importPath);
  const requireFromExpo = createRequire(
    path.join(expoProjectRoot, "package.json"),
  );
  const expoBin = requireFromExpo.resolve("expo/bin/cli");
  const bundlePath = path.join(root, `${name}.jsbundle`);
  const bundle = command(
    process.execPath,
    [
      expoBin,
      "export:embed",
      "--entry-file",
      "entry.js",
      "--platform",
      "ios",
      "--dev",
      "false",
      "--minify",
      "false",
      "--unstable-transform-profile",
      "hermes",
      "--bundle-output",
      bundlePath,
      "--assets-dest",
      path.join(root, "assets"),
      "--reset-cache",
      "--max-workers",
      "2",
    ],
    root,
    {
      ...process.env,
      EXPO_NO_DOTENV: "1",
    },
  );
  if (bundle.status !== 0) return bundle;

  const reactNativeRoot = path.dirname(
    requireFromExpo.resolve("react-native/package.json"),
  );
  const hermes = command(
    path.join(reactNativeRoot, "sdks/hermesc/osx-bin/hermesc"),
    ["-emit-binary", "-out", path.join(root, `${name}.hbc`), bundlePath],
    root,
  );
  return {
    ...bundle,
    status: hermes.status,
    stdout: `${bundle.stdout ?? ""}\n${hermes.stdout ?? ""}`,
    stderr: `${bundle.stderr ?? ""}\n${hermes.stderr ?? ""}`,
    hermesExitCode: hermes.status,
  };
}

try {
  const tarballBytes = await readFile(tarball);
  const actualSha256 = createHash("sha256").update(tarballBytes).digest("hex");
  if (actualSha256 !== expectedTarballSha256) {
    throw new Error(`Kamino 10 tarball hash mismatch: ${actualSha256}`);
  }
  await mkdir(candidateRoot, { recursive: true });
  const extracted = command(
    "tar",
    ["-xzf", tarball, "-C", candidateRoot, "--strip-components=1"],
    mapperRoot,
  );
  if (extracted.status !== 0) {
    throw new Error(
      `Kamino 10 tarball extraction failed: ${detail(extracted).output.join("\n")}`,
    );
  }
  await symlink(
    path.join(mapperRoot, "node_modules"),
    path.join(candidateRoot, "node_modules"),
    "dir",
  );

  const lowLevelImport = path.join(
    candidateRoot,
    "dist/@codegen/kvault/instructions/deposit.js",
  );
  const rootImport = path.join(candidateRoot, "dist/index.js");
  const nextLowLevel = await runNextProbe("low-level", lowLevelImport);
  const nextRoot = await runNextProbe("root", rootImport);
  const expoLowLevel = await runExpoProbe("low-level", lowLevelImport);
  const expoRoot = await runExpoProbe("root", rootImport);

  const results = {
    node: process.version,
    next: {
      lowLevel: detail(nextLowLevel),
      root: detail(nextRoot),
    },
    expoHermes: {
      lowLevel: detail(expoLowLevel),
      root: detail(expoRoot),
    },
  };
  console.log(JSON.stringify(results, null, 2));

  if (
    nextLowLevel.status !== 0 ||
    nextRoot.status === 0 ||
    expoLowLevel.status !== 0 ||
    expoRoot.status === 0
  ) {
    throw new Error(
      "Kamino 10 runtime classification changed; review the emitted results before updating the compatibility evaluation",
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
