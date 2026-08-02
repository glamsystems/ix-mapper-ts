import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(path.join(packageRoot, "package-lock.json"), "utf8"),
);
const manifestSchema = JSON.parse(
  await readFile(
    path.join(packageRoot, "compatibility-manifests/schema-v1.json"),
    "utf8",
  ),
);
const verifySdkTarballs =
  process.env.IX_MAPPER_VERIFY_SDK_TARBALLS === "1";
const sdkTarballChecks = new Map();

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function equalBytes(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function resolveSchemaRef(rootSchema, reference) {
  invariant(reference.startsWith("#/"), `Unsupported schema ref: ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], rootSchema);
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "object" ? "object" : typeof value;
}

function validateJsonSchema(value, schema, rootSchema, location = "manifest") {
  if (schema.$ref) {
    const referenced = resolveSchemaRef(rootSchema, schema.$ref);
    invariant(referenced, `${location} references missing ${schema.$ref}`);
    validateJsonSchema(value, referenced, rootSchema, location);
  }

  if (schema.const !== undefined) {
    invariant(value === schema.const, `${location} must equal ${schema.const}`);
  }
  if (schema.enum) {
    invariant(schema.enum.includes(value), `${location} is not in its enum`);
  }
  if (schema.oneOf) {
    let matches = 0;
    for (const candidate of schema.oneOf) {
      try {
        validateJsonSchema(value, candidate, rootSchema, location);
        matches += 1;
      } catch {
        // A oneOf branch is expected to reject when another branch matches.
      }
    }
    invariant(matches === 1, `${location} must match exactly one schema branch`);
  }

  if (schema.type) {
    const actualType = valueType(value);
    const matches =
      schema.type === actualType ||
      (schema.type === "number" && actualType === "integer");
    invariant(matches, `${location} must be ${schema.type}, got ${actualType}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined) {
      invariant(value.length >= schema.minLength, `${location} is too short`);
    }
    if (schema.pattern) {
      invariant(new RegExp(schema.pattern).test(value), `${location} pattern`);
    }
    if (schema.format === "date") {
      const [year, month, day] = value.split("-").map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      invariant(
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          parsed.getUTCFullYear() === year &&
          parsed.getUTCMonth() === month - 1 &&
          parsed.getUTCDate() === day,
        `${location} must be an ISO date`,
      );
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined) {
    invariant(value >= schema.minimum, `${location} is below its minimum`);
  }
  if (typeof value === "number" && schema.maximum !== undefined) {
    invariant(value <= schema.maximum, `${location} is above its maximum`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) {
      invariant(value.length >= schema.minItems, `${location} has too few items`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateJsonSchema(item, schema.items, rootSchema, `${location}[${index}]`),
      );
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (schema.minProperties !== undefined) {
      invariant(
        entries.length >= schema.minProperties,
        `${location} has too few properties`,
      );
    }
    for (const required of schema.required ?? []) {
      invariant(
        Object.hasOwn(value, required),
        `${location}.${required} is required`,
      );
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of entries) {
      if (properties[key]) {
        validateJsonSchema(
          child,
          properties[key],
          rootSchema,
          `${location}.${key}`,
        );
      } else if (schema.additionalProperties === false) {
        throw new Error(`${location}.${key} is not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateJsonSchema(
          child,
          schema.additionalProperties,
          rootSchema,
          `${location}.${key}`,
        );
      }
    }
  }
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function verifySdkTarball(label, sdk, sdkLock) {
  if (!verifySdkTarballs) return false;

  const cacheKey = `${sdk.package}@${sdk.version}:${sdk.tarball_sha256}`;
  if (!sdkTarballChecks.has(cacheKey)) {
    sdkTarballChecks.set(
      cacheKey,
      (async () => {
        invariant(
          typeof sdkLock.resolved === "string",
          `${label} SDK lockfile tarball URL is missing`,
        );
        const tarballUrl = new URL(sdkLock.resolved);
        invariant(
          tarballUrl.protocol === "https:" &&
            tarballUrl.hostname === "registry.npmjs.org",
          `${label} SDK tarball must resolve from registry.npmjs.org over HTTPS`,
        );
        const response = await fetch(tarballUrl, { redirect: "error" });
        invariant(
          response.ok,
          `${label} SDK tarball download failed: ${response.status}`,
        );
        invariant(response.body, `${label} SDK tarball response has no body`);
        const sha256Hash = createHash("sha256");
        const sha512Hash = createHash("sha512");
        let downloadedBytes = 0;
        for await (const chunk of response.body) {
          downloadedBytes += chunk.byteLength;
          invariant(
            downloadedBytes <= 100 * 1024 * 1024,
            `${label} SDK tarball exceeds the 100 MiB release limit`,
          );
          sha256Hash.update(chunk);
          sha512Hash.update(chunk);
        }
        const actual = sha256Hash.digest("hex");
        invariant(
          actual === sdk.tarball_sha256,
          `${label} SDK tarball SHA-256 mismatch: ${actual}`,
        );
        const actualIntegrity = `sha512-${sha512Hash.digest("base64")}`;
        invariant(
          actualIntegrity === sdk.npm_integrity,
          `${label} SDK tarball npm integrity mismatch`,
        );
      })(),
    );
  }
  await sdkTarballChecks.get(cacheKey);
  return true;
}

function resolveBundledPath(relativePath) {
  invariant(
    typeof relativePath === "string" && relativePath.length > 0,
    "Bundled artifact path must be a non-empty string",
  );
  const resolved = path.resolve(packageRoot, relativePath);
  invariant(
    resolved.startsWith(`${packageRoot}${path.sep}`),
    `Bundled artifact escapes package root: ${relativePath}`,
  );
  return resolved;
}

function resolvePackagePath(packagePath) {
  invariant(
    typeof packagePath === "string" && packagePath.length > 0,
    "Package artifact path must be a non-empty string",
  );
  return require.resolve(packagePath);
}

async function verifyArtifact(name, artifact) {
  invariant(
    typeof artifact?.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(artifact.sha256),
    `${name} has an invalid SHA-256`,
  );
  const hasBundledPath = artifact.bundled_path !== undefined;
  const hasPackagePath = artifact.package_path !== undefined;
  invariant(
    hasBundledPath !== hasPackagePath,
    `${name} must specify exactly one artifact path`,
  );
  const filePath = hasBundledPath
    ? resolveBundledPath(artifact.bundled_path)
    : resolvePackagePath(artifact.package_path);
  const actual = await sha256(filePath);
  invariant(actual === artifact.sha256, `${name} hash mismatch: ${actual}`);
  return filePath;
}

function fixedDestinationCount(instruction) {
  return (
    instruction.dynamic_accounts.length +
    instruction.static_accounts.length +
    instruction.index_map.filter((index) => index !== -1).length
  );
}

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function flattenNativeAccounts(accounts, parents = []) {
  return accounts.flatMap((account) => {
    if (Array.isArray(account.accounts)) {
      const groupName = account.name.replace(/Accounts$/, "");
      return flattenNativeAccounts(account.accounts, [...parents, groupName]);
    }
    return [
      {
        name: [...parents, account.name].map(snakeCase).join("_"),
        writable: account.isMut ?? account.writable ?? false,
        signer: account.isSigner ?? account.signer ?? false,
      },
    ];
  });
}

function verifyAccountLayouts(label, configured, nativeInstruction, proxyInstruction) {
  const nativeAccounts = flattenNativeAccounts(nativeInstruction.accounts);
  invariant(
    nativeAccounts.length === configured.strict.fixed_accounts.length,
    `${label}:${configured.src_ix_name} native IDL account count drift`,
  );

  configured.strict.fixed_accounts.forEach((constraint, index) => {
    const nativeAccount = nativeAccounts[index];
    invariant(
      constraint.index === index &&
        constraint.writable === nativeAccount.writable &&
        constraint.signer === nativeAccount.signer,
      `${label}:${configured.src_ix_name} source account ${index} role/order drift`,
    );
  });

  const destinationCount = fixedDestinationCount(configured);
  invariant(
    proxyInstruction.accounts.length === destinationCount,
    `${label}:${configured.dst_ix_name} proxy IDL account count drift`,
  );
  const expected = Array(destinationCount);

  for (const account of configured.dynamic_accounts) {
    expected[account.index] = {
      kind: "dynamic",
      name: snakeCase(account.name),
      writable: account.writable,
      signer: account.signer,
    };
  }
  for (const account of configured.static_accounts) {
    expected[account.index] = {
      kind: "static",
      address: account.account,
      writable: account.writable,
      signer: account.signer,
    };
  }
  configured.index_map.forEach((destinationIndex, sourceIndex) => {
    if (destinationIndex === -1) return;
    const sourceAccount = nativeAccounts[sourceIndex];
    expected[destinationIndex] = {
      kind: "mapped",
      name: sourceAccount.name,
      writable: sourceAccount.writable,
      signer: sourceAccount.signer,
    };
  });

  expected.forEach((account, index) => {
    invariant(account, `${label}:${configured.dst_ix_name} destination ${index} is unbound`);
    const proxyAccount = proxyInstruction.accounts[index];
    const proxyWritable = proxyAccount.writable ?? false;
    const proxySigner = proxyAccount.signer ?? false;
    invariant(
      account.writable === proxyWritable && account.signer === proxySigner,
      `${label}:${configured.dst_ix_name} destination account ${index} role drift`,
    );
    if (account.kind === "static") {
      invariant(
        proxyAccount.address === account.address,
        `${label}:${configured.dst_ix_name} static account ${index} identity drift`,
      );
    } else {
      invariant(
        snakeCase(proxyAccount.name) === account.name,
        `${label}:${configured.dst_ix_name} destination account ${index} order/identity drift`,
      );
    }
  });
}

async function verifyManifest(fileName) {
  const manifestPath = path.join(
    packageRoot,
    "compatibility-manifests/v1",
    fileName,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateJsonSchema(manifest, manifestSchema, manifestSchema, fileName);
  const label = `${manifest.integration}:${manifest.variant}`;

  invariant(manifest.manifest_version === 1, `${label} manifest version`);
  invariant(
    ["proof-only", "supported", "deprecated", "withdraw-only"].includes(
      manifest.status,
    ),
    `${label} has an unknown status`,
  );
  invariant(
    manifest.mapper.package === packageManifest.name &&
      manifest.mapper.version === packageManifest.version &&
      manifest.mapper.config_schema_version === 2,
    `${label} mapper tuple does not match package.json`,
  );

  const sdk = manifest.native_protocol.official_sdk;
  invariant(
    packageManifest.devDependencies?.[sdk.package] === sdk.version,
    `${label} official SDK is not pinned exactly in devDependencies`,
  );
  const sdkLockKey = `node_modules/${sdk.package}`;
  const sdkLock = packageLock.packages?.[sdkLockKey];
  invariant(sdkLock?.version === sdk.version, `${label} SDK lock version`);
  invariant(
    sdkLock?.integrity === sdk.npm_integrity,
    `${label} SDK npm integrity mismatch`,
  );
  const sdkTarballVerified = await verifySdkTarball(label, sdk, sdkLock);

  for (const [dependency, version] of Object.entries(
    sdk.resolved_compatibility_dependencies,
  )) {
    const dependencyManifestPath = path.join(
      packageRoot,
      "node_modules",
      dependency,
      "package.json",
    );
    const dependencyManifest = JSON.parse(
      await readFile(dependencyManifestPath, "utf8"),
    );
    invariant(
      dependencyManifest.version === version,
      `${label} resolved ${dependency} ${dependencyManifest.version} != ${version}`,
    );
  }

  const verifiedArtifacts = {};
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    verifiedArtifacts[name] = await verifyArtifact(`${label}:${name}`, artifact);
  }

  const config = JSON.parse(
    await readFile(verifiedArtifacts.mapper_config, "utf8"),
  );
  invariant(config.schema_version === 2, `${label} config schema`);
  invariant(
    config.program_id === manifest.native_protocol.program_id,
    `${label} native program ID mismatch`,
  );
  invariant(
    config.proxy_program_id === manifest.proxy.program_id,
    `${label} proxy program ID mismatch`,
  );

  const proxyIdl = JSON.parse(
    await readFile(verifiedArtifacts.proxy_idl, "utf8"),
  );
  invariant(proxyIdl.address === manifest.proxy.program_id, `${label} proxy IDL`);
  invariant(
    proxyIdl.metadata?.version === manifest.proxy.version,
    `${label} proxy IDL version`,
  );
  const nativeIdl = JSON.parse(
    await readFile(verifiedArtifacts.native_idl, "utf8"),
  );

  invariant(
    manifest.supported_mappings.length === config.instructions.length,
    `${label} supported mapping count`,
  );
  for (const supported of manifest.supported_mappings) {
    const configured = config.instructions.find(
      ({ src_ix_name }) => src_ix_name === supported.source_instruction,
    );
    invariant(configured, `${label} missing ${supported.source_instruction}`);
    invariant(
      equalBytes(configured.src_discriminator, supported.source_discriminator) &&
        equalBytes(
          configured.dst_discriminator,
          supported.destination_discriminator,
        ),
      `${label}:${supported.source_instruction} discriminator drift`,
    );
    invariant(
      configured.strict.data_length === supported.source_data_length &&
        configured.strict.fixed_accounts.length ===
          supported.source_fixed_accounts &&
        fixedDestinationCount(configured) ===
          supported.destination_fixed_accounts,
      `${label}:${supported.source_instruction} account/data shape drift`,
    );
    const proxyInstruction = proxyIdl.instructions.find(
      ({ name }) => name === supported.destination_instruction,
    );
    invariant(proxyInstruction, `${label} proxy instruction missing`);
    invariant(
      equalBytes(
        proxyInstruction.discriminator,
        supported.destination_discriminator,
      ) && proxyInstruction.accounts.length === supported.destination_fixed_accounts,
      `${label}:${supported.destination_instruction} proxy IDL drift`,
    );
    const nativeInstruction = nativeIdl.instructions.find(
      ({ name }) => name === supported.source_instruction,
    );
    invariant(nativeInstruction, `${label} native instruction missing`);
    verifyAccountLayouts(
      label,
      configured,
      nativeInstruction,
      proxyInstruction,
    );
  }

  if (manifest.status === "supported") {
    const requiredRuntimeGates = [
      "node_golden_fixtures",
      "next_client_build",
      "expo_hermes_bundle",
      "dependency_peer_graph",
    ];
    invariant(
      requiredRuntimeGates.every(
        (gate) => manifest.runtime_validation[gate] === true,
      ) && manifest.known_blockers.length === 0,
      `${label} cannot be supported while a runtime gate is false`,
    );
  }

  return {
    integration: manifest.integration,
    variant: manifest.variant,
    status: manifest.status,
    sdkTarballVerified,
    artifacts: Object.keys(verifiedArtifacts).length,
    mappings: manifest.supported_mappings.length,
  };
}

const manifestFiles = (await readdir(
  path.join(packageRoot, "compatibility-manifests/v1"),
))
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();
invariant(manifestFiles.length > 0, "No compatibility manifests found");

const verified = [];
for (const fileName of manifestFiles) {
  verified.push(await verifyManifest(fileName));
}

if (!packageManifest.version.includes("-")) {
  invariant(
    verified.every(({ status }) => status !== "proof-only"),
    `Stable ${packageManifest.version} cannot ship proof-only compatibility manifests`,
  );
}

console.log(JSON.stringify({ verified }, null, 2));
