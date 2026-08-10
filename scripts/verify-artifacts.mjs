import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

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
const manifestSchemaV1 = JSON.parse(
  await readFile(
    path.join(packageRoot, "compatibility-manifests/schema-v1.json"),
    "utf8",
  ),
);
const manifestSchemaV2 = JSON.parse(
  await readFile(
    path.join(packageRoot, "compatibility-manifests/schema-v2.json"),
    "utf8",
  ),
);
const compatibilityEvaluationSchema = JSON.parse(
  await readFile(
    path.join(packageRoot, "compatibility-evaluations/schema-v1.json"),
    "utf8",
  ),
);
const instructionClassificationSchema = JSON.parse(
  await readFile(
    path.join(packageRoot, "instruction-classifications-v1/schema-v1.json"),
    "utf8",
  ),
);
const operationProfileSchemaV1 = JSON.parse(
  await readFile(
    path.join(packageRoot, "operation-profiles-v1/schema-v1.json"),
    "utf8",
  ),
);
const operationProfileSchemaV2 = JSON.parse(
  await readFile(
    path.join(packageRoot, "operation-profiles-v2/schema-v2.json"),
    "utf8",
  ),
);
const verifySdkTarballs = process.env.IX_MAPPER_VERIFY_SDK_TARBALLS === "1";
const sdkTarballChecks = new Map();
const maturityStates = Object.freeze([
  "proof-only",
  "preview",
  "supported",
  "withdraw-only",
  "hold",
  "deprecated",
]);

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

function isExactVersion(value) {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
}

async function resolveDependencyFromPackage(packageDirectory, dependency) {
  const packageRequire = createRequire(path.join(packageDirectory, "package.json"));
  let directory = path.dirname(packageRequire.resolve(dependency));
  while (directory.startsWith(packageRoot)) {
    try {
      const manifestPath = path.join(directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name === dependency) {
        return {
          directory,
          lockKey: path.relative(packageRoot, directory).split(path.sep).join("/"),
          manifest,
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Unable to resolve ${dependency} from ${path.relative(packageRoot, packageDirectory)}`,
  );
}

function extractTarEntry(tarball, entryPath) {
  const archive = gunzipSync(tarball);
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    const name = readString(0, 100);
    const prefix = readString(345, 500);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readString(124, 136).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    invariant(
      Number.isSafeInteger(size),
      `${entryPath} has an invalid tar size`,
    );
    const dataStart = offset + 512;
    if (fullName === entryPath) {
      return archive.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Tarball entry is missing: ${entryPath}`);
}

function assertUniqueStrings(values, label) {
  invariant(Array.isArray(values), `${label} must be an array`);
  const unique = new Set(values);
  invariant(
    values.every((value) => typeof value === "string" && value.length > 0),
    `${label} must contain non-empty strings`,
  );
  invariant(unique.size === values.length, `${label} contains duplicates`);
  return unique;
}

function verifyMaturityRuntimeGates(label, manifest) {
  if (manifest.status !== "preview" && manifest.status !== "supported") {
    return;
  }
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
    `${label} cannot be ${manifest.status} while a runtime gate is false`,
  );
}

function verifyMaturityPolicyContract() {
  const green = {
    runtime_validation: {
      node_golden_fixtures: true,
      next_client_build: true,
      expo_hermes_bundle: true,
      dependency_peer_graph: true,
    },
    known_blockers: [],
  };
  verifyMaturityRuntimeGates("preview-green-fixture", {
    ...green,
    status: "preview",
  });
  verifyMaturityRuntimeGates("supported-green-fixture", {
    ...green,
    status: "supported",
  });
  verifyMaturityRuntimeGates("hold-red-fixture", {
    status: "hold",
    runtime_validation: {
      ...green.runtime_validation,
      expo_hermes_bundle: false,
    },
    known_blockers: ["held intentionally"],
  });
  let previewRejected = false;
  try {
    verifyMaturityRuntimeGates("preview-red-fixture", {
      status: "preview",
      runtime_validation: {
        ...green.runtime_validation,
        expo_hermes_bundle: false,
      },
      known_blockers: [],
    });
  } catch {
    previewRejected = true;
  }
  invariant(previewRejected, "preview maturity must enforce runtime gates");
}

function discriminatorsOverlap(left, right) {
  const prefixLength = Math.min(left.length, right.length);
  for (let index = 0; index < prefixLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
    invariant(
      matches === 1,
      `${location} must match exactly one schema branch`,
    );
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
      invariant(
        value.length >= schema.minItems,
        `${location} has too few items`,
      );
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateJsonSchema(
          item,
          schema.items,
          rootSchema,
          `${location}[${index}]`,
        ),
      );
    }
    if (schema.prefixItems) {
      invariant(
        value.length >= schema.prefixItems.length,
        `${location} has fewer items than its required prefix`,
      );
      schema.prefixItems.forEach((itemSchema, index) =>
        validateJsonSchema(
          value[index],
          itemSchema,
          rootSchema,
          `${location}[${index}]`,
        ),
      );
    }
    if (schema.maxItems !== undefined) {
      invariant(
        value.length <= schema.maxItems,
        `${location} has too many items`,
      );
    }
    if (schema.uniqueItems === true) {
      invariant(
        new Set(value.map((item) => JSON.stringify(item))).size ===
          value.length,
        `${location} contains duplicate items`,
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
        leafName: snakeCase(account.name),
        writable: account.isMut ?? account.writable ?? false,
        signer: account.isSigner ?? account.signer ?? false,
        optional: account.isOptional ?? account.optional ?? false,
      },
    ];
  });
}

function verifyAccountLayouts(
  label,
  configured,
  nativeInstruction,
  proxyInstruction,
) {
  const nativeAccounts = flattenNativeAccounts(nativeInstruction.accounts);
  invariant(
    nativeAccounts.length === configured.strict.fixed_accounts.length,
    `${label}:${configured.src_ix_name} native IDL account count drift`,
  );

  configured.strict.fixed_accounts.forEach((constraint, index) => {
    const nativeAccount = nativeAccounts[index];
    const optionalPlaceholder =
      configured.program_id_placeholder_indices?.includes(index) ?? false;
    invariant(
      constraint.index === index &&
        (optionalPlaceholder
          ? nativeAccount.optional &&
            constraint.writable === false &&
            constraint.signer === false
          : constraint.writable === nativeAccount.writable &&
            constraint.signer === nativeAccount.signer),
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
    const sourceConstraint = configured.strict.fixed_accounts[sourceIndex];
    const optionalPlaceholder =
      configured.program_id_placeholder_indices?.includes(sourceIndex) ?? false;
    expected[destinationIndex] = {
      kind: "mapped",
      names: [sourceAccount.name, sourceAccount.leafName],
      writable: sourceConstraint.writable,
      signer: sourceConstraint.signer,
      optionalPlaceholder,
    };
  });

  expected.forEach((account, index) => {
    invariant(
      account,
      `${label}:${configured.dst_ix_name} destination ${index} is unbound`,
    );
    const proxyAccount = proxyInstruction.accounts[index];
    const proxyWritable = proxyAccount.writable ?? false;
    const proxySigner = proxyAccount.signer ?? false;
    const placeholderRoleAccepted =
      account.optionalPlaceholder &&
      (proxyAccount.optional ?? false) &&
      account.writable === false &&
      account.signer === false;
    invariant(
      placeholderRoleAccepted ||
        (account.writable === proxyWritable && account.signer === proxySigner),
      `${label}:${configured.dst_ix_name} destination account ${index} role drift`,
    );
    if (account.kind === "static") {
      invariant(
        proxyAccount.address === account.address,
        `${label}:${configured.dst_ix_name} static account ${index} identity drift`,
      );
    } else {
      invariant(
        account.kind === "mapped"
          ? account.names.includes(snakeCase(proxyAccount.name))
          : snakeCase(proxyAccount.name) === account.name,
        `${label}:${configured.dst_ix_name} destination account ${index} order/identity drift`,
      );
    }
  });
}

function safePassthroughShapeKey(rule) {
  return JSON.stringify({
    program_id: rule.program_id,
    data: rule.strict.data.bytes,
    accounts: rule.strict.fixed_accounts.map((account) => ({
      index: account.index,
      writable: account.writable,
      signer: account.signer,
      account: account.account,
      one_of_accounts: account.one_of_accounts
        ? [...account.one_of_accounts].sort()
        : undefined,
      dynamic_account: account.dynamic_account,
      same_as: account.same_as,
    })),
  });
}

function verifySafePassthroughRule(label, rule, rules) {
  invariant(
    Array.isArray(rule.discriminator) && rule.discriminator.length > 0,
    `${label}:${rule.id} safe passthrough requires an exact discriminator`,
  );
  invariant(
    rule.strict?.data?.kind === "exact" &&
      Array.isArray(rule.strict.data.bytes) &&
      rule.strict.data.bytes.length >= rule.discriminator.length &&
      rule.discriminator.every(
        (byte, index) => rule.strict.data.bytes[index] === byte,
      ),
    `${label}:${rule.id} safe passthrough requires exact data beginning with its discriminator`,
  );

  const accountConstraints = rule.strict.fixed_accounts;
  invariant(
    Array.isArray(accountConstraints) &&
      rule.strict.remaining_accounts?.kind === "none" &&
      Object.keys(rule.strict.remaining_accounts).length === 1,
    `${label}:${rule.id} safe passthrough requires an exact account count`,
  );
  const indices = new Set();
  accountConstraints.forEach((account, expectedIndex) => {
    invariant(
      account.index === expectedIndex && !indices.has(account.index),
      `${label}:${rule.id} safe passthrough account indices must be dense and unique`,
    );
    indices.add(account.index);
    invariant(
      typeof account.writable === "boolean" &&
        typeof account.signer === "boolean",
      `${label}:${rule.id} safe passthrough account ${account.index} has an invalid role`,
    );
    const identities = [
      account.account !== undefined,
      account.one_of_accounts !== undefined,
      account.dynamic_account !== undefined,
      account.same_as !== undefined,
    ].filter(Boolean).length;
    invariant(
      identities === 1,
      `${label}:${rule.id} safe passthrough account ${account.index} must have exactly one identity constraint`,
    );
    if (account.one_of_accounts !== undefined) {
      invariant(
        Array.isArray(account.one_of_accounts) &&
          account.one_of_accounts.length > 0 &&
          new Set(account.one_of_accounts).size ===
            account.one_of_accounts.length,
        `${label}:${rule.id} safe passthrough account ${account.index} has an invalid address allowlist`,
      );
    }
    if (account.dynamic_account !== undefined) {
      invariant(
        ["glam_state", "glam_vault", "glam_signer"].includes(
          account.dynamic_account,
        ),
        `${label}:${rule.id} safe passthrough account ${account.index} has a wildcard or unknown binding`,
      );
    }
    if (account.same_as !== undefined) {
      invariant(
        Number.isInteger(account.same_as) &&
          account.same_as >= 0 &&
          account.same_as < expectedIndex,
        `${label}:${rule.id} safe passthrough account ${account.index} has an invalid same_as constraint`,
      );
    }
  });
  invariant(
    typeof rule.rationale === "string" && rule.rationale.trim().length >= 8,
    `${label}:${rule.id} safe passthrough requires a rationale`,
  );

  for (const other of rules) {
    if (other.id === rule.id || other.program_id !== rule.program_id) continue;
    if (other.outcome === "mapped") {
      invariant(
        !discriminatorsOverlap(rule.discriminator, other.discriminator),
        `${label}:${rule.id} safe passthrough overlaps mapped ${other.id}`,
      );
    }
    if (other.outcome === "safePassthrough") {
      invariant(
        safePassthroughShapeKey(rule) !== safePassthroughShapeKey(other),
        `${label}:${rule.id} duplicates passthrough shape ${other.id}`,
      );
    }
  }
}

async function verifyInstructionClassifications(
  label,
  manifest,
  config,
  verifiedArtifacts,
) {
  const declaration = manifest.instruction_classification;
  invariant(
    Object.hasOwn(verifiedArtifacts, declaration.artifact),
    `${label} classification artifact reference is missing`,
  );
  invariant(
    verifiedArtifacts.instruction_classification_schema,
    `${label} classification schema artifact is missing`,
  );

  const bundledSchema = JSON.parse(
    await readFile(verifiedArtifacts.instruction_classification_schema, "utf8"),
  );
  invariant(
    JSON.stringify(bundledSchema) ===
      JSON.stringify(instructionClassificationSchema),
    `${label} classification schema artifact does not match the verifier schema`,
  );
  const classification = JSON.parse(
    await readFile(verifiedArtifacts[declaration.artifact], "utf8"),
  );
  validateJsonSchema(
    classification,
    instructionClassificationSchema,
    instructionClassificationSchema,
    `${label}:instruction-classification`,
  );
  invariant(
    classification.$schema === "./schema-v1.json" &&
      classification.schema_version === declaration.schema_version &&
      classification.config_revision === declaration.config_revision &&
      classification.integration === manifest.integration,
    `${label} classification schema, revision, or integration drift`,
  );

  const rulesById = new Map();
  for (const rule of classification.rules) {
    invariant(!rulesById.has(rule.id), `${label} duplicate rule id ${rule.id}`);
    rulesById.set(rule.id, rule);
    assertUniqueStrings(rule.emitted_by, `${label}:${rule.id} emitted_by`);
  }

  const farmsProgramBinding =
    manifest.native_protocol.official_sdk.program_bindings.find(
      ({ name }) => name === "kamino-farms",
    );
  if (manifest.integration === "kamino-kvault" && farmsProgramBinding) {
    const farmInstructions = new Set([
      "initializeUser",
      "stake",
      "unstake",
      "withdrawUnstakedDeposits",
    ]);
    const farmRules = classification.rules.filter(({ instruction }) =>
      farmInstructions.has(instruction),
    );
    invariant(
      farmRules.length === farmInstructions.size &&
        farmRules.every(
          ({ program_id }) => program_id === farmsProgramBinding.program_id,
        ),
      `${label} farm classifications do not exhaust the pinned Farms program profile`,
    );
  }

  const declarationsByOutcome = {
    mapped: assertUniqueStrings(
      declaration.mapped_rule_ids,
      `${label} mapped rule ids`,
    ),
    safePassthrough: assertUniqueStrings(
      declaration.safe_passthrough_rule_ids,
      `${label} safe passthrough rule ids`,
    ),
    unsupported: assertUniqueStrings(
      declaration.unsupported_rule_ids,
      `${label} unsupported rule ids`,
    ),
  };
  const allDeclaredIds = new Set();
  for (const [outcome, declaredIds] of Object.entries(declarationsByOutcome)) {
    for (const id of declaredIds) {
      invariant(
        !allDeclaredIds.has(id),
        `${label} classification ${id} is declared more than once`,
      );
      allDeclaredIds.add(id);
      invariant(rulesById.has(id), `${label} classification ${id} is missing`);
      invariant(
        rulesById.get(id).outcome === outcome,
        `${label} classification ${id} outcome drift`,
      );
    }
  }
  invariant(
    allDeclaredIds.size === classification.rules.length,
    `${label} manifest does not exhaustively reference classification rules`,
  );

  const mappedRules = classification.rules.filter(
    ({ outcome }) => outcome === "mapped",
  );
  invariant(
    mappedRules.length === config.instructions.length &&
      mappedRules.length === manifest.supported_mappings.length,
    `${label} mapped classification count drift`,
  );
  const mappedReferences = new Set();
  for (const rule of mappedRules) {
    const mapping = config.instructions.find(
      ({ src_ix_name }) => src_ix_name === rule.mapping_ref.source_instruction,
    );
    invariant(mapping, `${label}:${rule.id} mapping reference is missing`);
    const mappingReference = `${rule.program_id}:${mapping.src_ix_name}`;
    invariant(
      !mappedReferences.has(mappingReference),
      `${label}:${rule.id} duplicates mapping ${mappingReference}`,
    );
    mappedReferences.add(mappingReference);
    invariant(
      rule.program_id === config.program_id &&
        rule.instruction === mapping.src_ix_name &&
        rule.mapping_ref.config_schema_version === config.schema_version &&
        rule.mapping_ref.config_revision === config.config_revision &&
        equalBytes(rule.discriminator, mapping.src_discriminator),
      `${label}:${rule.id} mapping reference drift`,
    );
    const supported = manifest.supported_mappings.find(
      ({ source_instruction }) => source_instruction === rule.instruction,
    );
    invariant(
      supported &&
        equalBytes(supported.source_discriminator, rule.discriminator),
      `${label}:${rule.id} supported mapping mirror drift`,
    );
  }

  const safeRules = classification.rules.filter(
    ({ outcome }) => outcome === "safePassthrough",
  );
  safeRules.forEach((rule) =>
    verifySafePassthroughRule(label, rule, classification.rules),
  );

  const unsupportedRules = classification.rules.filter(
    ({ outcome }) => outcome === "unsupported",
  );
  const unsupportedMirrors = new Map();
  for (const mirror of manifest.explicitly_unsupported) {
    invariant(
      !unsupportedMirrors.has(mirror.classification_rule_id),
      `${label} duplicate unsupported mirror ${mirror.classification_rule_id}`,
    );
    unsupportedMirrors.set(mirror.classification_rule_id, mirror);
  }
  invariant(
    unsupportedMirrors.size === unsupportedRules.length,
    `${label} unsupported classification mirror count drift`,
  );
  for (const rule of unsupportedRules) {
    const mirror = unsupportedMirrors.get(rule.id);
    invariant(mirror, `${label}:${rule.id} unsupported mirror is missing`);
    invariant(
      mirror.instruction === rule.instruction &&
        mirror.reason === rule.reason &&
        (rule.discriminator === undefined
          ? mirror.discriminator === undefined
          : equalBytes(mirror.discriminator, rule.discriminator)),
      `${label}:${rule.id} unsupported mirror drift`,
    );
  }

  return {
    classifications: classification.rules.length,
    safePassthrough: safeRules.length,
  };
}

async function verifyOperationProfiles(
  label,
  manifest,
  config,
  verifiedArtifacts,
) {
  const declaration = manifest.operation_profile;
  const operationProfileSchema =
    declaration.schema_version === 1
      ? operationProfileSchemaV1
      : declaration.schema_version === 2
        ? operationProfileSchemaV2
        : undefined;
  invariant(
    operationProfileSchema,
    `${label} operation profile schema version`,
  );
  invariant(
    Object.hasOwn(verifiedArtifacts, declaration.artifact),
    `${label} operation profile artifact reference is missing`,
  );
  invariant(
    verifiedArtifacts.operation_profile_schema,
    `${label} operation profile schema artifact is missing`,
  );
  const bundledSchema = JSON.parse(
    await readFile(verifiedArtifacts.operation_profile_schema, "utf8"),
  );
  invariant(
    JSON.stringify(bundledSchema) === JSON.stringify(operationProfileSchema),
    `${label} operation profile schema artifact does not match the verifier schema`,
  );
  const profileConfig = JSON.parse(
    await readFile(verifiedArtifacts[declaration.artifact], "utf8"),
  );
  validateJsonSchema(
    profileConfig,
    operationProfileSchema,
    operationProfileSchema,
    `${label}:operation-profile`,
  );
  invariant(
    profileConfig.$schema ===
      `./schema-v${String(declaration.schema_version)}.json` &&
      profileConfig.schema_version === declaration.schema_version &&
      profileConfig.config_revision === declaration.config_revision &&
      profileConfig.integration === manifest.integration,
    `${label} operation profile schema, revision, or integration drift`,
  );

  const declaredIds = assertUniqueStrings(
    declaration.operation_ids,
    `${label} operation profile ids`,
  );
  const passthroughIds = assertUniqueStrings(
    declaration.operation_bound_passthrough_ids,
    `${label} operation-bound passthrough ids`,
  );
  invariant(
    declaredIds.size === profileConfig.operations.length &&
      [...passthroughIds].every((id) => declaredIds.has(id)),
    `${label} manifest does not exhaustively reference operation profiles`,
  );

  if (manifest.integration === "kamino-lending-repay") {
    invariant(
      declaration.schema_version === 2 && profileConfig.operations.length === 1,
      `${label} Klend repay requires one schema-v2 operation profile`,
    );
    const activeTuple = profileConfig.official_sdk_tuple;
    const expectedSourceHashes = {
      refresh_reserve_builder:
        "3a939f974db7db7f5a117af538574fab5ac3d6e68261468e8e8b3da70a3ddce4",
      refresh_obligation_builder:
        "e0d5fdc1aca1c7b021748ff01d4e8f66aab51c6d7443053ba2e4fa2d7f95549b",
      repay_v2_builder:
        "e6667c7e1b6d1ff4b441aaa664c59c8b2a48b582ccfcabbda4c9bc66bb327450",
      high_level_action_helper:
        "7d777cb44935360f1f67659394b6b4193ddeb41c5a5945aeff5aee798d964da5",
    };
    invariant(
      activeTuple.package === "@kamino-finance/klend-sdk" &&
        activeTuple.version === "9.1.5" &&
        activeTuple.version === manifest.native_protocol.official_sdk.version &&
        activeTuple.solana_kit_version === "2.3.0" &&
        JSON.stringify(activeTuple.source_hashes) ===
          JSON.stringify(expectedSourceHashes),
      `${label} Klend official SDK source tuple drift`,
    );
    const profile = profileConfig.operations[0];
    invariant(
      declaredIds.has(profile.id) &&
        passthroughIds.has(profile.id) &&
        profile.id === "klend.existing-obligation-classic-spl-repay-v2" &&
        profile.operation === "repayObligationLiquidityV2" &&
        profile.builder_authority ===
          "@kamino-finance/klend-sdk generated builders" &&
        profile.ordering_evidence ===
          "pinned KaminoAction.buildRepayTxns source" &&
        profile.maximum_snapshot_age_slots === 20 &&
        profile.amount === "positive-finite-u64" &&
        profile.token_program ===
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
        profile.associated_token_program ===
          "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" &&
        profile.farms_program ===
          "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr" &&
        equalBytes(profile.forbidden_liquidity_mints, [
          "So11111111111111111111111111111111111111112",
        ]) &&
        equalBytes(profile.forbidden_helpers, [
          "associated-token-account",
          "compute-budget",
          "elevation-group",
          "farms",
          "fixed-term",
          "initialization",
          "lookup-table",
          "referrer",
          "repay-all",
          "scope-refresh",
          "token-2022",
          "wrapped-sol",
        ]) &&
        profile.sequence.refresh_reserves.outcome ===
          "operationBoundPassthrough" &&
        profile.sequence.refresh_reserves.ordering ===
          "deposits-then-borrows-deduplicated-target-last" &&
        equalBytes(
          profile.sequence.refresh_reserves.exact_data,
          [2, 218, 138, 235, 79, 201, 25, 102],
        ) &&
        profile.sequence.refresh_obligation.outcome ===
          "operationBoundPassthrough" &&
        profile.sequence.refresh_obligation.remaining_accounts.binding ===
          "deposit_reserves_then_borrow_reserves" &&
        profile.sequence.refresh_obligation.remaining_accounts.referrer_tail ===
          "forbidden" &&
        equalBytes(
          profile.sequence.refresh_obligation.exact_data,
          [33, 132, 147, 228, 151, 192, 72, 89],
        ) &&
        profile.sequence.protocol.outcome === "mapped" &&
        profile.sequence.protocol.position === "final" &&
        profile.sequence.protocol.source_instruction ===
          "repay_obligation_liquidity_v2",
      `${label} Klend operation grammar drift`,
    );
    const mapping = config.instructions.find(
      ({ src_ix_name }) =>
        src_ix_name === profile.sequence.protocol.source_instruction,
    );
    invariant(
      mapping &&
        config.instructions.length === 1 &&
        mapping.strict.remaining_accounts.kind === "none" &&
        mapping.strict.fixed_accounts.length ===
          profile.sequence.protocol.account_bindings.length &&
        mapping.strict.fixed_accounts.every(
          (account, index) =>
            account.index === index &&
            account.writable ===
              ((profile.sequence.protocol.account_bindings[index].role & 1) !==
                0) &&
            account.signer ===
              ((profile.sequence.protocol.account_bindings[index].role & 2) !==
                0),
        ),
      `${label} Klend operation mapping/account binding drift`,
    );
    return { operationProfiles: 1 };
  }

  if (manifest.integration === "kamino-farms-stake") {
    invariant(
      declaration.schema_version === 2 &&
        profileConfig.operations.length === 2 &&
        passthroughIds.size === 0,
      `${label} Farms stake requires two mapped-only schema-v2 profiles`,
    );
    const expectedSourceHashes = {
      farms_client:
        "7b1cd629d3727c0d97b5b69f669aaf3503e0f09ecf4188470aed3a2a82c62026",
      operations:
        "7fcb2ec4b6ce3107b63f7b5d79e28eceb2ddec86b5488d17f6c663d9620d20a3",
      pda_helpers:
        "30554409cb42f0dd31d898110ee0711f0ccb879f888231713c85cd0983b2c79d",
      initialize_user_builder:
        "12a413b5064a274c21fb04fd71460110b5c66faa750779ac1cfabf6ca7325f10",
      stake_builder:
        "78a10d19eeb3c0bc071db902918368342a0cfcab5fd2451cabbaef3b87338342",
    };
    const tuple = profileConfig.official_sdk_tuple;
    invariant(
      tuple.package === "@kamino-finance/farms-sdk" &&
        tuple.version === "3.2.26" &&
        tuple.native_idl_version === "1.6.5" &&
        tuple.version === manifest.native_protocol.official_sdk.version &&
        tuple.solana_kit_version === "2.3.0" &&
        tuple.tarball_sha256 ===
          "21155adcc0d05a12f68e203547c983373adbe29bbbb098b249e9eaf4a75633bb" &&
        JSON.stringify(tuple.source_hashes) ===
          JSON.stringify(expectedSourceHashes),
      `${label} Farms official SDK/IDL source tuple drift`,
    );
    const expected = {
      stake: {
        id: "farms.existing-user-classic-spl-stake",
        emitter: "Farms.stakeIx",
        userState: "existing",
        sequence: ["stake"],
      },
      initializeAndStake: {
        id: "farms.first-stake-classic-spl",
        emitter: "Farms.createNewUserIx + Farms.stakeIx",
        userState: "absent",
        sequence: ["initialize_user", "stake"],
      },
    };
    for (const profile of profileConfig.operations) {
      const shape = expected[profile.operation];
      invariant(
        shape &&
          declaredIds.has(profile.id) &&
          profile.id === shape.id &&
          profile.official_emitter === shape.emitter &&
          profile.user_state === shape.userState &&
          profile.atomic === true &&
          profile.maximum_snapshot_age_slots === 20 &&
          profile.amount === "positive-finite-u64" &&
          profile.farms_program ===
            "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr" &&
          profile.token_program ===
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
          profile.associated_token_program ===
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" &&
          profile.scope_prices === "none-program-sentinel" &&
          equalBytes(
            profile.sequence.map(({ source_instruction }) =>
              source_instruction,
            ),
            shape.sequence,
          ) &&
          profile.sequence.every(
            (step, index) =>
              step.position === index &&
              step.outcome === "mapped" &&
              step.account_bindings.length === 8,
          ),
        `${label}:${profile.id} Farms operation grammar drift`,
      );
      for (const step of profile.sequence) {
        const mapping = config.instructions.find(
          ({ src_ix_name }) => src_ix_name === step.source_instruction,
        );
        invariant(
          mapping &&
            mapping.strict.remaining_accounts.kind === "none" &&
            mapping.strict.fixed_accounts.length ===
              step.account_bindings.length &&
            mapping.strict.fixed_accounts.every(
              (account, index) =>
                account.index === index &&
                account.writable ===
                  ((step.account_bindings[index].role & 1) !== 0) &&
                account.signer ===
                  ((step.account_bindings[index].role & 2) !== 0),
            ),
          `${label}:${profile.id}:${step.source_instruction} mapping/account binding drift`,
        );
      }
    }
    return { operationProfiles: 2 };
  }

  if (manifest.integration === "jupiter-earn") {
    invariant(
      declaration.schema_version === 2 &&
        profileConfig.operations.length === 2 &&
        passthroughIds.size === 0,
      `${label} Jupiter Earn requires two mapped-only schema-v2 profiles`,
    );
    const expectedSourceHashes = {
      official_earn_entry:
        "3f0d9bfc18a999c21dfd02177bab855e367626776e8b70bd436911d9107f4a62",
      native_idl:
        "ef547c925d93149437ffa7cd6be91f7bf3d97a95960c219227b0da91cadb9bd0",
      portable_binding:
        "41c26c9f0fb079eea57bb35948c21553d90c6377f3bbcf3a58b88bddbf195b97",
      operation_vectors:
        "08503390a2f235cad434022ffbe4e38791c704eed0bfec2dca20030e30b159b0",
      portable_instructions:
        "a522235f4d286a7cda8bc22999a79a4b7b435e3e34ac1e6425c3ed082d57c671",
      portable_enumeration:
        "61e144e9c8a7223b5915e5dfb37f015375eed4a0a25a5966e984c1fa8bc3add3",
      portable_structural:
        "2ff1b89c085621de4447f5aaac6f88180d84350f694ce84f1f5e09f1eef9e238",
      portable_differential:
        "41081bb0df2a5b94c687229294369d15024e4c6f364b32860ae1af3b869f6cd1",
    };
    const tuple = profileConfig.official_sdk_tuple;
    invariant(
      tuple.package === "@jup-ag/lend" &&
        tuple.version === "0.1.10" &&
        tuple.version === manifest.native_protocol.official_sdk.version &&
        tuple.native_idl_version === "0.1.0" &&
        tuple.solana_kit_version === "2.3.0" &&
        tuple.tarball_sha256 ===
          "fd84fefecc1a517ddfae64b2b61d293e2cbc854a84c7836181a42dcdec6f5810" &&
        JSON.stringify(tuple.source_hashes) ===
          JSON.stringify(expectedSourceHashes),
      `${label} Jupiter official SDK/IDL/source tuple drift`,
    );
    const expected = {
      depositWithMinAmountOut: {
        id: "jupiter-earn.main-classic-spl-deposit-with-min-out",
        emitter:
          "@jup-ag/lend Program.methods.depositWithMinAmountOut + bounded portable binding",
        amounts: "nonzero-u64-assets-and-min-out",
        source: "deposit_with_min_amount_out",
        accounts: 17,
      },
      redeemWithMinAmountOut: {
        id: "jupiter-earn.main-classic-spl-redeem-with-min-out",
        emitter:
          "@jup-ag/lend Program.methods.redeemWithMinAmountOut + bounded portable binding",
        amounts: "nonzero-u64-shares-and-min-out",
        source: "redeem_with_min_amount_out",
        accounts: 18,
      },
    };
    for (const profile of profileConfig.operations) {
      const shape = expected[profile.operation];
      const external = profile.external_profile;
      invariant(
        shape &&
          declaredIds.has(profile.id) &&
          profile.id === shape.id &&
          profile.official_emitter === shape.emitter &&
          profile.bounded_binding ===
            "pinned decoded Lending/TokenReserve state plus immutable jupiter-earn-main-classic-spl-v1 output" &&
          profile.atomic === true &&
          profile.maximum_snapshot_age_slots === 20 &&
          profile.amounts === shape.amounts &&
          profile.requires_existing_atas === true &&
          external.profile === "jupiter-earn-main-classic-spl-v1" &&
          external.market === "main" &&
          external.lending_program ===
            "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9" &&
          external.liquidity_program ===
            "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC" &&
          external.reward_rate_model_program ===
            "jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar" &&
          external.asset_token_program ===
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
          external.f_token_program ===
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
          external.associated_token_program ===
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" &&
          external.system_program === "11111111111111111111111111111111" &&
          external.setup === "none" &&
          external.base_commit ===
            "4053ffbad104ce7f17505f4b3b85d5b1b414fc37" &&
          external.hardening_commit ===
            "356ed8420edc24ceb518d88440f4e17c24378c61" &&
          profile.sequence.length === 1 &&
          profile.sequence[0].position === 0 &&
          profile.sequence[0].outcome === "mapped" &&
          profile.sequence[0].source_instruction === shape.source &&
          profile.sequence[0].account_bindings.length === shape.accounts,
        `${label}:${profile.id} Jupiter operation grammar drift`,
      );
      const mapping = config.instructions.find(
        ({ src_ix_name }) => src_ix_name === shape.source,
      );
      invariant(
        mapping &&
          mapping.strict.remaining_accounts.kind === "none" &&
          mapping.strict.fixed_accounts.length === shape.accounts &&
          mapping.strict.fixed_accounts.every(
            (account, index) =>
              account.index === index &&
              account.writable ===
                ((profile.sequence[0].account_bindings[index].role & 1) !== 0) &&
              account.signer ===
                ((profile.sequence[0].account_bindings[index].role & 2) !== 0),
          ),
        `${label}:${profile.id} Jupiter mapping/account binding drift`,
      );
    }

    const provenance = JSON.parse(
      await readFile(verifiedArtifacts.portable_binding_provenance, "utf8"),
    );
    invariant(
      provenance.integration === "jupiter-earn" &&
        provenance.profile === "jupiter-earn-main-classic-spl-v1" &&
        provenance.repository === "glamsystems/glam" &&
        provenance.native_idl.commit ===
          "aa654a2e6739b25f9d72ac91da7540ba7e9990dd" &&
        provenance.native_idl.sha256 === expectedSourceHashes.native_idl &&
        provenance.portable_binding.base_commit ===
          "4053ffbad104ce7f17505f4b3b85d5b1b414fc37" &&
        provenance.portable_binding.hardening_commit ===
          "356ed8420edc24ceb518d88440f4e17c24378c61" &&
        provenance.portable_binding.files.instructions.sha256 ===
          expectedSourceHashes.portable_instructions &&
        provenance.portable_binding.files.enumeration.sha256 ===
          expectedSourceHashes.portable_enumeration &&
        provenance.portable_binding.files.structural.sha256 ===
          expectedSourceHashes.portable_structural &&
        provenance.portable_binding.files.differential_check.sha256 ===
          expectedSourceHashes.portable_differential &&
        provenance.programs.lending === manifest.native_protocol.program_id &&
        provenance.programs.liquidity ===
          "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC" &&
        provenance.programs.reward_rate_model ===
          "jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar" &&
        provenance.setup === "none" &&
        provenance.operations.length === 2,
      `${label} portable binding provenance drift`,
    );
    const vectors = JSON.parse(
      await readFile(verifiedArtifacts.operation_vectors, "utf8"),
    );
    invariant(
      vectors.source.base_commit === provenance.portable_binding.base_commit &&
        vectors.source.hardening_commit ===
          provenance.portable_binding.hardening_commit &&
        Number.isInteger(vectors.source.slot) &&
        vectors.lending.ownerProgramAddress ===
          manifest.native_protocol.program_id &&
        vectors.tokenReserve.ownerProgramAddress ===
          provenance.programs.liquidity &&
        vectors.tokenReserve.address ===
          vectors.lending.tokenReservesLiquidityAddress &&
        vectors.tokenReserve.mintAddress === vectors.lending.mintAddress,
      `${label} Jupiter decoded-state vector provenance drift`,
    );
    for (const [operation, shape] of Object.entries(expected)) {
      const vector =
        operation === "depositWithMinAmountOut"
          ? vectors.deposit.instruction
          : vectors.redeem.instruction;
      const mapping = config.instructions.find(
        ({ src_ix_name }) => src_ix_name === shape.source,
      );
      invariant(
        vector.programAddress === manifest.native_protocol.program_id &&
          vector.accounts.length === shape.accounts &&
          vector.data.length === 24 &&
          equalBytes(vector.data.slice(0, 8), mapping.src_discriminator) &&
          vector.accounts.every(
            (account, index) =>
              account.role ===
              ((mapping.strict.fixed_accounts[index].signer ? 2 : 0) |
                (mapping.strict.fixed_accounts[index].writable ? 1 : 0)),
          ),
        `${label}:${shape.source} portable vector drift`,
      );
    }
    return { operationProfiles: 2 };
  }

  invariant(
    manifest.integration === "kamino-kvaults" &&
      declaration.schema_version === 1,
    `${label} has no reviewed operation-profile verifier`,
  );

  const expected = {
    deposit: {
      id: "kvault.classic-deposit-with-ata",
      count: [1, 1],
      source: "deposit",
      indices: [0, 7, 5, 10],
      forbidden: [3],
    },
    withdraw: {
      id: "kvault.classic-withdraw-with-ata",
      count: [1, 25],
      source: "withdraw",
      indices: [0, 5, 6, 9],
      forbidden: [6],
    },
  };
  const profileKeys = new Set();
  for (const profile of profileConfig.operations) {
    invariant(
      declaredIds.has(profile.id) && passthroughIds.has(profile.id),
      `${label}:${profile.id} is not declared by the manifest`,
    );
    const profileKey = `${profile.id}:${profile.operation}:${profile.setup.position}`;
    invariant(
      !profileKeys.has(profileKey),
      `${label}:${profile.id} duplicates an operation/profile position`,
    );
    profileKeys.add(profileKey);

    const oracle = expected[profile.operation];
    invariant(
      oracle &&
        profile.id === oracle.id &&
        profile.protocol.source_instruction === oracle.source &&
        profile.protocol.minimum_count === oracle.count[0] &&
        profile.protocol.maximum_count === oracle.count[1] &&
        equalBytes(
          [
            profile.protocol.owner_account_index,
            profile.protocol.token_account_index,
            profile.protocol.token_mint_index,
            profile.protocol.token_program_index,
          ],
          oracle.indices,
        ) &&
        equalBytes(
          profile.protocol.forbidden_mint_account_indices,
          oracle.forbidden,
        ) &&
        equalBytes(profile.protocol.forbidden_mints, [
          "So11111111111111111111111111111111111111112",
        ]),
      `${label}:${profile.id} KVault sequence grammar drift`,
    );
    const mapping = config.instructions.find(
      ({ src_ix_name }) => src_ix_name === profile.protocol.source_instruction,
    );
    invariant(mapping, `${label}:${profile.id} source mapping is missing`);
    const indices = [
      profile.protocol.owner_account_index,
      profile.protocol.token_account_index,
      profile.protocol.token_mint_index,
      profile.protocol.token_program_index,
      ...profile.protocol.forbidden_mint_account_indices,
    ];
    invariant(
      indices.every(
        (index) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < mapping.strict.fixed_accounts.length,
      ) &&
        mapping.strict.fixed_accounts[profile.protocol.owner_account_index]
          .dynamic_account === "glam_vault",
      `${label}:${profile.id} source binding index drift`,
    );

    const setup = profile.setup;
    const expectedSetup = [
      { role: 3, binding: "ata_payer" },
      { role: 1, binding: "derived_associated_token_account" },
      { role: 0, binding: "glam_vault" },
      { role: 0, binding: "protocol_token_mint" },
      { role: 0, account: "11111111111111111111111111111111" },
      { role: 0, binding: "protocol_token_program" },
    ];
    invariant(
      setup.outcome === "operationBoundPassthrough" &&
        setup.position === 0 &&
        setup.program_id === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" &&
        setup.instruction === "CreateIdempotent" &&
        equalBytes(setup.exact_data, [1]) &&
        setup.accounts.length === expectedSetup.length &&
        setup.accounts.every(
          (account, index) =>
            account.index === index &&
            account.role === expectedSetup[index].role &&
            account.binding === expectedSetup[index].binding &&
            account.account === expectedSetup[index].account,
        ),
      `${label}:${profile.id} operation-bound ATA contract drift`,
    );
  }

  return { operationProfiles: profileConfig.operations.length };
}

async function verifyOperationProfileSchemaPolicyContract() {
  const klend = JSON.parse(
    await readFile(
      path.join(
        packageRoot,
        "operation-profiles-v2/kamino-lending-repay.json",
      ),
      "utf8",
    ),
  );
  const farms = JSON.parse(
    await readFile(
      path.join(packageRoot, "operation-profiles-v2/kamino-farms-stake.json"),
      "utf8",
    ),
  );
  const jupiter = JSON.parse(
    await readFile(
      path.join(packageRoot, "operation-profiles-v2/jupiter-earn.json"),
      "utf8",
    ),
  );
  validateJsonSchema(
    klend,
    operationProfileSchemaV2,
    operationProfileSchemaV2,
    "operation-profile-schema-contract:klend",
  );
  validateJsonSchema(
    farms,
    operationProfileSchemaV2,
    operationProfileSchemaV2,
    "operation-profile-schema-contract:farms",
  );
  validateJsonSchema(
    jupiter,
    operationProfileSchemaV2,
    operationProfileSchemaV2,
    "operation-profile-schema-contract:jupiter",
  );

  const expectRejected = (value, label) => {
    let rejected = false;
    try {
      validateJsonSchema(
        value,
        operationProfileSchemaV2,
        operationProfileSchemaV2,
        label,
      );
    } catch {
      rejected = true;
    }
    invariant(rejected, `${label} must fail the published schema`);
  };

  const klendWithFarmsTuple = structuredClone(klend);
  klendWithFarmsTuple.official_sdk_tuple = structuredClone(
    farms.official_sdk_tuple,
  );
  expectRejected(
    klendWithFarmsTuple,
    "operation-profile-schema-contract:klend-cross-tuple",
  );

  const farmsWithKlendTuple = structuredClone(farms);
  farmsWithKlendTuple.official_sdk_tuple = structuredClone(
    klend.official_sdk_tuple,
  );
  expectRejected(
    farmsWithKlendTuple,
    "operation-profile-schema-contract:farms-cross-tuple",
  );

  const klendWithFarmsOperation = structuredClone(klend);
  klendWithFarmsOperation.operations.push(
    structuredClone(farms.operations[0]),
  );
  expectRejected(
    klendWithFarmsOperation,
    "operation-profile-schema-contract:klend-mixed-operation",
  );

  const farmsWithKlendOperation = structuredClone(farms);
  farmsWithKlendOperation.operations.push(
    structuredClone(klend.operations[0]),
  );
  expectRejected(
    farmsWithKlendOperation,
    "operation-profile-schema-contract:farms-mixed-operation",
  );

  const farmsWithStaleBoundDrift = structuredClone(farms);
  farmsWithStaleBoundDrift.operations[0].maximum_snapshot_age_slots = 21;
  expectRejected(
    farmsWithStaleBoundDrift,
    "operation-profile-schema-contract:farms-snapshot-bound-drift",
  );

  for (const [name, tuple] of [
    ["klend", klend.official_sdk_tuple],
    ["farms", farms.official_sdk_tuple],
  ]) {
    const crossTuple = structuredClone(jupiter);
    crossTuple.official_sdk_tuple = structuredClone(tuple);
    expectRejected(
      crossTuple,
      `operation-profile-schema-contract:jupiter-${name}-tuple`,
    );
  }
  const jupiterWithFarmsOperation = structuredClone(jupiter);
  jupiterWithFarmsOperation.operations.push(
    structuredClone(farms.operations[0]),
  );
  expectRejected(
    jupiterWithFarmsOperation,
    "operation-profile-schema-contract:jupiter-mixed-operation",
  );
  const farmsWithJupiterOperation = structuredClone(farms);
  farmsWithJupiterOperation.operations.push(
    structuredClone(jupiter.operations[0]),
  );
  expectRejected(
    farmsWithJupiterOperation,
    "operation-profile-schema-contract:farms-jupiter-operation",
  );
  const jupiterWithMismatchedBranch = structuredClone(jupiter);
  jupiterWithMismatchedBranch.operations[0].sequence[0].source_instruction =
    "redeem_with_min_amount_out";
  expectRejected(
    jupiterWithMismatchedBranch,
    "operation-profile-schema-contract:jupiter-operation-branch-drift",
  );
  const jupiterWithDuplicateDeposit = structuredClone(jupiter);
  jupiterWithDuplicateDeposit.operations[1] = structuredClone(
    jupiter.operations[0],
  );
  expectRejected(
    jupiterWithDuplicateDeposit,
    "operation-profile-schema-contract:jupiter-duplicate-deposit",
  );
  const jupiterWithMarketDrift = structuredClone(jupiter);
  jupiterWithMarketDrift.operations[0].external_profile.market = "ethena";
  expectRejected(
    jupiterWithMarketDrift,
    "operation-profile-schema-contract:jupiter-market-drift",
  );
  const jupiterWithRewardProgramDrift = structuredClone(jupiter);
  jupiterWithRewardProgramDrift.operations[0].external_profile.reward_rate_model_program =
    "11111111111111111111111111111111";
  expectRejected(
    jupiterWithRewardProgramDrift,
    "operation-profile-schema-contract:jupiter-reward-program-drift",
  );
  const jupiterWithStaleBoundDrift = structuredClone(jupiter);
  jupiterWithStaleBoundDrift.operations[0].maximum_snapshot_age_slots = 21;
  expectRejected(
    jupiterWithStaleBoundDrift,
    "operation-profile-schema-contract:jupiter-snapshot-bound-drift",
  );
}

function verifySafePassthroughPolicyContract() {
  const fixtureRule = {
    id: "contract.exact-native",
    outcome: "safePassthrough",
    program_id: "11111111111111111111111111111111",
    instruction: "ExactNative",
    phase: "setup",
    emitted_by: ["policy contract fixture"],
    condition: "only this exact structural fixture",
    discriminator: [42],
    rationale: "Exercises the published schema and release verifier together.",
    strict: {
      data: { kind: "exact", bytes: [42, 7] },
      fixed_accounts: [
        {
          index: 0,
          writable: false,
          signer: true,
          dynamic_account: "glam_signer",
        },
        {
          index: 1,
          writable: false,
          signer: false,
          same_as: 0,
        },
      ],
      remaining_accounts: { kind: "none" },
    },
  };
  const fixtureConfig = {
    $schema: "./schema-v1.json",
    schema_version: 1,
    config_revision: 1,
    integration: "policy-contract-fixture",
    rules: [
      fixtureRule,
      {
        id: "contract.unapproved-native-variant",
        outcome: "unsupported",
        program_id: fixtureRule.program_id,
        instruction: "UnapprovedNativeVariant",
        phase: "setup",
        emitted_by: ["policy contract fixture"],
        condition: "any unapproved variant sharing the discriminator",
        discriminator: fixtureRule.discriminator,
        reason: "Sharing a discriminator never grants passthrough approval.",
      },
    ],
  };
  validateJsonSchema(
    fixtureConfig,
    instructionClassificationSchema,
    instructionClassificationSchema,
    "safe-passthrough-policy-contract",
  );
  verifySafePassthroughRule(
    "safe-passthrough-policy-contract",
    fixtureRule,
    fixtureConfig.rules,
  );
}

async function verifyManifest(manifestVersion, fileName) {
  const manifestPath = path.join(
    packageRoot,
    `compatibility-manifests/v${String(manifestVersion)}`,
    fileName,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestSchema =
    manifestVersion === 2 ? manifestSchemaV2 : manifestSchemaV1;
  validateJsonSchema(manifest, manifestSchema, manifestSchema, fileName);
  const label = `${manifest.integration}:${manifest.variant}`;

  invariant(
    manifest.manifest_version === manifestVersion &&
      Number.isInteger(manifest.manifest_revision) &&
      manifest.manifest_revision >= 1,
    `${label} manifest version or revision`,
  );
  invariant(
    maturityStates.includes(manifest.status),
    `${label} has an unknown status`,
  );
  invariant(
    manifest.mapper.package === packageManifest.name &&
      (manifestVersion === 1 ||
        manifest.mapper.version === packageManifest.version) &&
      isExactVersion(manifest.mapper.version) &&
      manifest.mapper.config_schema_version === 2 &&
      Number.isInteger(manifest.mapper.config_revision) &&
      manifest.mapper.config_revision >= 1,
    `${label} mapper tuple does not match package.json`,
  );

  const sdk = manifest.native_protocol.official_sdk;
  invariant(
    isExactVersion(sdk.version) &&
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
  const sdkPackageDirectory = path.join(
    packageRoot,
    "node_modules",
    ...sdk.package.split("/"),
  );
  const sdkPackageManifest = JSON.parse(
    await readFile(path.join(sdkPackageDirectory, "package.json"), "utf8"),
  );

  const programBindingsByName = new Map();
  for (const binding of sdk.program_bindings) {
    invariant(
      !programBindingsByName.has(binding.name),
      `${label} duplicate program binding ${binding.name}`,
    );
    programBindingsByName.set(binding.name, binding);
  }
  const farmsProgramBinding = programBindingsByName.get("kamino-farms");
  invariant(
    ![
      "kamino-kvaults",
      "kamino-lending-repay",
      "kamino-farms-stake",
    ].includes(
      manifest.integration,
    ) ||
      (farmsProgramBinding?.mode === "sdk-default-only" &&
        typeof farmsProgramBinding.constraint === "string" &&
        farmsProgramBinding.constraint.includes("outside this profile")),
    `${label} must pin the default-only Kamino Farms program profile`,
  );
  if (manifest.integration === "jupiter-earn") {
    const lendingBinding = programBindingsByName.get("jupiter-lending-main");
    const liquidityBinding = programBindingsByName.get("jupiter-liquidity");
    const rewardsBinding = programBindingsByName.get(
      "jupiter-lending-rewards",
    );
    invariant(
      programBindingsByName.size === 3 &&
        lendingBinding?.program_id ===
          "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9" &&
        lendingBinding.mode === "sdk-default-only" &&
        lendingBinding.constraint.includes("outside this profile") &&
        liquidityBinding?.program_id ===
          "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC" &&
        liquidityBinding.mode === "sdk-default-only" &&
        liquidityBinding.constraint.includes("outside this profile") &&
        rewardsBinding?.program_id ===
          "jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar" &&
        rewardsBinding.mode === "sdk-default-only" &&
        rewardsBinding.constraint.includes("outside this profile"),
      `${label} must pin the exact Jupiter Lending/Liquidity/rewards profile`,
    );
  }

  const kit = sdk.solana_kit;
  const kitLock = packageLock.packages?.[`node_modules/${kit.package}`];
  const officialSdkDeclaresKit = Object.hasOwn(
    sdkPackageManifest.dependencies ?? {},
    kit.package,
  );
  invariant(
    kit.package === "@solana/kit" &&
      isExactVersion(kit.version) &&
      packageManifest.devDependencies?.[kit.package] === kit.version &&
      (officialSdkDeclaresKit
        ? sdk.resolved_compatibility_dependencies[kit.package] === kit.version
        : sdk.resolved_compatibility_dependencies[kit.package] === undefined) &&
      kitLock?.version === kit.version &&
      kitLock?.integrity === kit.npm_integrity,
    `${label} Solana Kit tuple is not pinned exactly`,
  );

  for (const [dependency, pin] of Object.entries(
    sdk.verified_compatibility_packages,
  )) {
    const dependencyLock = packageLock.packages?.[`node_modules/${dependency}`];
    const dependencyManifest = JSON.parse(
      await readFile(
        path.join(packageRoot, "node_modules", dependency, "package.json"),
        "utf8",
      ),
    );
    invariant(
      isExactVersion(pin.version) &&
        sdk.resolved_compatibility_dependencies[dependency] === pin.version &&
        dependencyManifest.version === pin.version &&
        dependencyLock?.version === pin.version &&
        dependencyLock?.integrity === pin.npm_integrity,
      `${label} verified compatibility package ${dependency} is not pinned exactly`,
    );
  }

  const usesPackageScopedDependencyResolution = [
    "kamino-farms-stake",
    "jupiter-earn",
  ].includes(manifest.integration);
  if (usesPackageScopedDependencyResolution) {
    const officialDependencies = Object.keys(
      sdkPackageManifest.dependencies ?? {},
    ).sort();
    const declaredDependencies = Object.keys(
      sdk.resolved_compatibility_dependencies,
    ).sort();
    invariant(
      JSON.stringify(declaredDependencies) ===
        JSON.stringify(officialDependencies),
      `${label} resolved dependencies do not exhaust the official SDK package`,
    );
    for (const dependency of officialDependencies) {
      const resolved = await resolveDependencyFromPackage(
        sdkPackageDirectory,
        dependency,
      );
      const version = sdk.resolved_compatibility_dependencies[dependency];
      const dependencyLock = packageLock.packages?.[resolved.lockKey];
      invariant(
        isExactVersion(version) &&
          resolved.manifest.version === version &&
          dependencyLock?.version === version &&
          typeof dependencyLock.integrity === "string" &&
          dependencyLock.integrity.length > 0,
        `${label} package-resolved ${dependency} is not pinned at ${resolved.lockKey}`,
      );
    }
  }

  for (const [dependency, version] of Object.entries(
    usesPackageScopedDependencyResolution
      ? {}
      : sdk.resolved_compatibility_dependencies,
  )) {
    invariant(
      isExactVersion(version),
      `${label} resolved ${dependency} is not an exact version`,
    );
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
    const dependencyLock = packageLock.packages?.[`node_modules/${dependency}`];
    invariant(
      dependencyLock?.version === version &&
        typeof dependencyLock.integrity === "string" &&
        dependencyLock.integrity.length > 0,
      `${label} resolved ${dependency} is not pinned by lockfile integrity`,
    );
  }

  const verifiedArtifacts = {};
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    verifiedArtifacts[name] = await verifyArtifact(
      `${label}:${name}`,
      artifact,
    );
  }
  const integrationArtifacts =
    manifest.integration === "kamino-kvaults"
      ? [
          "high_level_kvault_helper_source",
          "high_level_ata_helper_source",
          "high_level_farm_helper_source",
          "farms_client_source",
          "farms_operations_source",
          "farms_program_source",
          "farms_initialize_user_schema",
          "farms_stake_schema",
          "farms_unstake_schema",
          "farms_withdraw_unstaked_deposits_schema",
        ]
      : manifest.integration === "kamino-lending-repay"
        ? [
            "native_refresh_reserve_schema",
            "native_refresh_obligation_schema",
            "native_repay_v2_schema",
            "high_level_action_helper_source",
            "farms_program_source",
          ]
        : manifest.integration === "kamino-farms-stake"
          ? [
              "farms_client_source",
              "farms_operations_source",
              "farms_pda_helpers_source",
              "farms_program_source",
              "farms_initialize_user_schema",
              "farms_stake_schema",
              "farms_unstake_schema",
            ]
          : manifest.integration === "jupiter-earn"
            ? [
                "official_earn_entry_source",
                "portable_binding_provenance",
                "operation_vectors",
              ]
          : [];
  for (const requiredArtifact of [
    "native_idl",
    "proxy_idl",
    "mapper_config",
    "instruction_classification_schema",
    "instruction_classification_config",
    ...integrationArtifacts,
    ...(manifestVersion === 2
      ? ["operation_profile_schema", "operation_profile_config"]
      : []),
  ]) {
    invariant(
      verifiedArtifacts[requiredArtifact],
      `${label} required artifact ${requiredArtifact} is missing`,
    );
  }

  if (farmsProgramBinding) {
    const farmsProgramSource = await readFile(
      verifiedArtifacts.farms_program_source,
      "utf8",
    );
    const defaultProgram = /FARMS_PROGRAM_ADDRESS\s*=\s*["']([^"']+)["']/.exec(
      farmsProgramSource,
    )?.[1];
    invariant(
      defaultProgram === farmsProgramBinding.program_id,
      `${label} Farms SDK default program does not match the pinned profile`,
    );
  }

  const config = JSON.parse(
    await readFile(verifiedArtifacts.mapper_config, "utf8"),
  );
  invariant(
    config.schema_version === manifest.mapper.config_schema_version &&
      config.config_revision === manifest.mapper.config_revision,
    `${label} config schema or revision`,
  );
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
  invariant(
    proxyIdl.address === manifest.proxy.program_id,
    `${label} proxy IDL`,
  );
  invariant(
    proxyIdl.metadata?.version === manifest.proxy.version,
    `${label} proxy IDL version`,
  );
  const nativeIdl = JSON.parse(
    await readFile(verifiedArtifacts.native_idl, "utf8"),
  );
  if (manifest.integration === "kamino-farms-stake") {
    invariant(
      nativeIdl.metadata?.version === "1.6.5" &&
        nativeIdl.address === manifest.native_protocol.program_id,
      `${label} Farms native IDL version/program drift`,
    );
  }
  if (manifest.integration === "jupiter-earn") {
    invariant(
      nativeIdl.metadata?.version === "0.1.0" &&
        nativeIdl.address === manifest.native_protocol.program_id,
      `${label} Jupiter native IDL version/program drift`,
    );
  }

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
      equalBytes(
        configured.src_discriminator,
        supported.source_discriminator,
      ) &&
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
      ) &&
        proxyInstruction.accounts.length ===
          supported.destination_fixed_accounts,
      `${label}:${supported.destination_instruction} proxy IDL drift`,
    );
    const nativeInstruction = nativeIdl.instructions.find(
      ({ name }) =>
        name === supported.source_instruction ||
        snakeCase(name) === supported.source_instruction,
    );
    invariant(nativeInstruction, `${label} native instruction missing`);
    verifyAccountLayouts(
      label,
      configured,
      nativeInstruction,
      proxyInstruction,
    );
  }

  const classificationSummary = await verifyInstructionClassifications(
    label,
    manifest,
    config,
    verifiedArtifacts,
  );
  const operationSummary =
    manifestVersion === 2
      ? await verifyOperationProfiles(
          label,
          manifest,
          config,
          verifiedArtifacts,
        )
      : { operationProfiles: 0 };

  verifyMaturityRuntimeGates(label, manifest);

  return {
    integration: manifest.integration,
    variant: manifest.variant,
    status: manifest.status,
    manifestRevision: manifest.manifest_revision,
    manifestVersion,
    active: manifestVersion === 2,
    sdkTarballVerified,
    artifacts: Object.keys(verifiedArtifacts).length,
    mappings: manifest.supported_mappings.length,
    classifications: classificationSummary.classifications,
    safePassthrough: classificationSummary.safePassthrough,
    operationProfiles: operationSummary.operationProfiles,
  };
}

async function verifyEvaluation(fileName) {
  const evaluationPath = path.join(
    packageRoot,
    "compatibility-evaluations/v1",
    fileName,
  );
  const evaluation = JSON.parse(await readFile(evaluationPath, "utf8"));
  validateJsonSchema(
    evaluation,
    compatibilityEvaluationSchema,
    compatibilityEvaluationSchema,
    fileName,
  );
  const label = `${evaluation.integration}:${evaluation.official_sdk.version}`;
  invariant(
    isExactVersion(evaluation.official_sdk.version),
    `${label} SDK version is not exact`,
  );
  invariant(
    evaluation.official_sdk.package === evaluation.baseline.package &&
      evaluation.official_sdk.version !== evaluation.baseline.version,
    `${label} must be a separate version of the baseline package`,
  );

  const baselinePath = resolveBundledPath(evaluation.baseline.manifest);
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  invariant(
    baseline.integration === evaluation.integration &&
      baseline.native_protocol.official_sdk.package ===
        evaluation.baseline.package &&
      baseline.native_protocol.official_sdk.version ===
        evaluation.baseline.version,
    `${label} baseline manifest does not match the evaluation`,
  );

  for (const [name, comparison] of Object.entries(
    evaluation.artifact_comparison.unchanged,
  )) {
    invariant(
      comparison.package_path.startsWith("dist/") &&
        !comparison.package_path.includes(".."),
      `${label}:${name} has an unsafe package path`,
    );
    const baselineArtifactPath = require.resolve(
      `${evaluation.baseline.package}/${comparison.package_path}`,
    );
    invariant(
      (await sha256(baselineArtifactPath)) === comparison.baseline_sha256,
      `${label}:${name} baseline artifact hash drift`,
    );
    invariant(
      comparison.baseline_sha256 === comparison.candidate_sha256,
      `${label}:${name} is declared unchanged but hashes differ`,
    );
  }
  for (const [name, comparison] of Object.entries(
    evaluation.artifact_comparison.changed,
  )) {
    invariant(
      comparison.package_path.startsWith("dist/") &&
        !comparison.package_path.includes(".."),
      `${label}:${name} has an unsafe package path`,
    );
    const baselineArtifactPath = require.resolve(
      `${evaluation.baseline.package}/${comparison.package_path}`,
    );
    invariant(
      (await sha256(baselineArtifactPath)) === comparison.baseline_sha256,
      `${label}:${name} baseline artifact hash drift`,
    );
    invariant(
      comparison.baseline_sha256 !== comparison.candidate_sha256,
      `${label}:${name} is declared changed but hashes match`,
    );
  }

  const tarballUrl = new URL(evaluation.official_sdk.tarball_url);
  invariant(
    tarballUrl.protocol === "https:" &&
      tarballUrl.hostname === "registry.npmjs.org",
    `${label} tarball must be pinned to registry.npmjs.org over HTTPS`,
  );

  let sdkTarballVerified = false;
  if (verifySdkTarballs) {
    const response = await fetch(tarballUrl, { redirect: "error" });
    invariant(
      response.ok,
      `${label} tarball download failed: ${response.status}`,
    );
    invariant(response.body, `${label} tarball response has no body`);
    const sha256Hash = createHash("sha256");
    const sha512Hash = createHash("sha512");
    const chunks = [];
    let downloadedBytes = 0;
    for await (const chunk of response.body) {
      downloadedBytes += chunk.byteLength;
      invariant(
        downloadedBytes <= 100 * 1024 * 1024,
        `${label} tarball exceeds the 100 MiB evaluation limit`,
      );
      sha256Hash.update(chunk);
      sha512Hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    invariant(
      sha256Hash.digest("hex") === evaluation.official_sdk.tarball_sha256,
      `${label} tarball SHA-256 mismatch`,
    );
    invariant(
      `sha512-${sha512Hash.digest("base64")}` ===
        evaluation.official_sdk.npm_integrity,
      `${label} tarball npm integrity mismatch`,
    );
    const tarball = Buffer.concat(chunks);
    for (const [name, comparison] of Object.entries({
      ...evaluation.artifact_comparison.unchanged,
      ...evaluation.artifact_comparison.changed,
    })) {
      const candidate = extractTarEntry(
        tarball,
        `package/${comparison.package_path}`,
      );
      invariant(
        createHash("sha256").update(candidate).digest("hex") ===
          comparison.candidate_sha256,
        `${label}:${name} candidate artifact hash drift`,
      );
    }
    sdkTarballVerified = true;
  }

  return {
    integration: evaluation.integration,
    sdkVersion: evaluation.official_sdk.version,
    status: evaluation.status,
    evaluationRevision: evaluation.evaluation_revision,
    sdkTarballVerified,
    unchangedArtifacts: Object.keys(evaluation.artifact_comparison.unchanged)
      .length,
    changedArtifacts: Object.keys(evaluation.artifact_comparison.changed)
      .length,
    runtimeValidation: evaluation.runtime_validation,
  };
}

const manifestFiles = [];
for (const manifestVersion of [1, 2]) {
  const files = (
    await readdir(
      path.join(
        packageRoot,
        `compatibility-manifests/v${String(manifestVersion)}`,
      ),
    )
  )
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  manifestFiles.push(
    ...files.map((fileName) => ({ fileName, manifestVersion })),
  );
}
invariant(manifestFiles.length > 0, "No compatibility manifests found");
verifySafePassthroughPolicyContract();
verifyMaturityPolicyContract();
await verifyOperationProfileSchemaPolicyContract();

const verified = [];
for (const { fileName, manifestVersion } of manifestFiles) {
  verified.push(await verifyManifest(manifestVersion, fileName));
}

const evaluationFiles = (
  await readdir(path.join(packageRoot, "compatibility-evaluations/v1"))
)
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();
const evaluations = [];
for (const fileName of evaluationFiles) {
  evaluations.push(await verifyEvaluation(fileName));
}

if (!packageManifest.version.includes("-")) {
  invariant(
    verified
      .filter(({ active }) => active)
      .every(({ status }) => status !== "proof-only"),
    `Stable ${packageManifest.version} cannot ship proof-only compatibility manifests`,
  );
}

console.log(JSON.stringify({ verified, evaluations }, null, 2));
