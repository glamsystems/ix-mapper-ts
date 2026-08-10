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
const manifestSchema = JSON.parse(
  await readFile(
    path.join(packageRoot, "compatibility-manifests/schema-v1.json"),
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
        writable: account.isMut ?? account.writable ?? false,
        signer: account.isSigner ?? account.signer ?? false,
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
    invariant(
      account,
      `${label}:${configured.dst_ix_name} destination ${index} is unbound`,
    );
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
  if (farmsProgramBinding) {
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

async function verifyManifest(fileName) {
  const manifestPath = path.join(
    packageRoot,
    "compatibility-manifests/v1",
    fileName,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateJsonSchema(manifest, manifestSchema, manifestSchema, fileName);
  const label = `${manifest.integration}:${manifest.variant}`;

  invariant(
    manifest.manifest_version === 1 &&
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
      manifest.mapper.version === packageManifest.version &&
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
    manifest.integration !== "kamino-kvaults" ||
      (farmsProgramBinding?.mode === "sdk-default-only" &&
        typeof farmsProgramBinding.constraint === "string" &&
        farmsProgramBinding.constraint.includes("outside this profile")),
    `${label} must pin the default-only Kamino Farms program profile`,
  );

  const kit = sdk.solana_kit;
  const kitLock = packageLock.packages?.[`node_modules/${kit.package}`];
  invariant(
    kit.package === "@solana/kit" &&
      isExactVersion(kit.version) &&
      packageManifest.devDependencies?.[kit.package] === kit.version &&
      sdk.resolved_compatibility_dependencies[kit.package] === kit.version &&
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

  for (const [dependency, version] of Object.entries(
    sdk.resolved_compatibility_dependencies,
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
  for (const requiredArtifact of [
    "mapper_config",
    "instruction_classification_schema",
    "instruction_classification_config",
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

  const classificationSummary = await verifyInstructionClassifications(
    label,
    manifest,
    config,
    verifiedArtifacts,
  );

  verifyMaturityRuntimeGates(label, manifest);

  return {
    integration: manifest.integration,
    variant: manifest.variant,
    status: manifest.status,
    manifestRevision: manifest.manifest_revision,
    sdkTarballVerified,
    artifacts: Object.keys(verifiedArtifacts).length,
    mappings: manifest.supported_mappings.length,
    classifications: classificationSummary.classifications,
    safePassthrough: classificationSummary.safePassthrough,
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

const manifestFiles = (
  await readdir(path.join(packageRoot, "compatibility-manifests/v1"))
)
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();
invariant(manifestFiles.length > 0, "No compatibility manifests found");
verifySafePassthroughPolicyContract();
verifyMaturityPolicyContract();

const verified = [];
for (const fileName of manifestFiles) {
  verified.push(await verifyManifest(fileName));
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
    verified.every(({ status }) => status !== "proof-only"),
    `Stable ${packageManifest.version} cannot ship proof-only compatibility manifests`,
  );
}

console.log(JSON.stringify({ verified, evaluations }, null, 2));
