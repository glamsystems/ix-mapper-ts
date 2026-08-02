import StrictKvauGMspProgramConfig from "../mapping-configs-v2/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import StrictStagingKvauGMspProgramConfig from "../mapping-configs-v2-staging/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import KaminoKvauInstructionClassifications from "../instruction-classifications-v1/kamino-kvaults.json";

import type {
  InstructionClassificationConfig,
  MapInstructionOptions,
  NeutralInstructionInput,
  NeutralMapInstructionResult,
  NeutralMapperEnvironment,
  NeutralMappingContext,
  StrictRemappingConfig,
  StrictRemappingConfigs,
} from "./core-types";
import { normalizeInstructionNeutral } from "./neutral";
import {
  mapInstructionWithConfigs,
  validateInstructionClassificationConfig,
  validateStrictRemappingConfigs,
} from "./strict";

function unsupported(message: string): NeutralMapInstructionResult {
  return { kind: "unsupported", reason: "invalid-instruction", message };
}

function parseStaging(options: MapInstructionOptions | undefined): boolean {
  if (options === undefined) return false;
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError("Mapper options must be an object");
  }
  const unknown = Object.keys(options).filter((key) => key !== "staging");
  if (unknown.length > 0) {
    throw new TypeError(`Unknown mapper option: ${unknown.sort()[0]}`);
  }
  if (options.staging !== undefined && typeof options.staging !== "boolean") {
    throw new TypeError("Mapper staging option must be boolean");
  }
  return options.staging ?? false;
}

/** Create a synchronous, client-neutral mapper over bundled schema-v2 configs. */
function createNeutralMapper(environment: NeutralMapperEnvironment) {
  if (
    typeof environment !== "object" ||
    environment === null ||
    typeof environment.normalizeAddress !== "function"
  ) {
    throw new TypeError("Neutral mapper requires an address normalizer");
  }

  const production: StrictRemappingConfigs = validateStrictRemappingConfigs(
    {
      [StrictKvauGMspProgramConfig.program_id]:
        StrictKvauGMspProgramConfig as StrictRemappingConfig,
    },
    environment,
  );
  const staging: StrictRemappingConfigs = validateStrictRemappingConfigs(
    {
      [StrictStagingKvauGMspProgramConfig.program_id]:
        StrictStagingKvauGMspProgramConfig as StrictRemappingConfig,
    },
    environment,
  );
  const productionClassifications = validateInstructionClassificationConfig(
    KaminoKvauInstructionClassifications as InstructionClassificationConfig,
    production,
    environment,
  );
  const stagingClassifications = validateInstructionClassificationConfig(
    KaminoKvauInstructionClassifications as InstructionClassificationConfig,
    staging,
    environment,
  );

  function mapInstructionNeutral(
    instruction: NeutralInstructionInput,
    context: NeutralMappingContext,
    options?: MapInstructionOptions,
  ): NeutralMapInstructionResult {
    try {
      const useStaging = parseStaging(options);
      const normalized = normalizeInstructionNeutral(instruction, environment);
      return mapInstructionWithConfigs(
        normalized,
        context,
        useStaging ? staging : production,
        useStaging ? stagingClassifications : productionClassifications,
        environment,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return unsupported(
        `Instruction could not be normalized safely: ${message}`,
      );
    }
  }

  function mapInstructionsNeutral(
    instructions: readonly NeutralInstructionInput[],
    context: NeutralMappingContext,
    options?: MapInstructionOptions,
  ): NeutralMapInstructionResult[] {
    if (!Array.isArray(instructions)) {
      return [unsupported("Instruction batch must be an array")];
    }
    return instructions.map((instruction) =>
      mapInstructionNeutral(instruction, context, options),
    );
  }

  return { mapInstructionNeutral, mapInstructionsNeutral } as const;
}

export { createNeutralMapper };
export type * from "./core-types";
/** Alias documenting direct structural compatibility with Solana Kit. */
export type { NeutralInstructionInput as SolanaKitInstruction } from "./core-types";
