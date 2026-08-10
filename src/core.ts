import StrictKvauGMspProgramConfig from "../mapping-configs-v2/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import StrictStagingKvauGMspProgramConfig from "../mapping-configs-v2-staging/KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd.json";
import StrictKlendProgramConfig from "../mapping-configs-v2/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.json";
import StrictStagingKlendProgramConfig from "../mapping-configs-v2-staging/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD.json";
import StrictFarmsProgramConfig from "../mapping-configs-v2/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";
import StrictStagingFarmsProgramConfig from "../mapping-configs-v2-staging/FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr.json";
import StrictJupiterEarnProgramConfig from "../mapping-configs-v2/jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9.json";
import StrictStagingJupiterEarnProgramConfig from "../mapping-configs-v2-staging/jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9.json";
import KaminoKvauInstructionClassifications from "../instruction-classifications-v1/kamino-kvaults.json";
import KaminoLendingRepayClassifications from "../instruction-classifications-v1/kamino-lending-repay.json";
import KaminoFarmsStakeClassifications from "../instruction-classifications-v1/kamino-farms-stake.json";
import JupiterEarnClassifications from "../instruction-classifications-v1/jupiter-earn.json";
import KaminoKvauOperationProfiles from "../operation-profiles-v1/kamino-kvaults.json";
import KaminoLendingRepayOperationProfiles from "../operation-profiles-v2/kamino-lending-repay.json";
import KaminoFarmsStakeOperationProfiles from "../operation-profiles-v2/kamino-farms-stake.json";
import JupiterEarnOperationProfiles from "../operation-profiles-v2/jupiter-earn.json";

import type {
  InstructionClassificationConfig,
  MapInstructionOptions,
  NeutralInstructionInput,
  NeutralMapInstructionResult,
  NeutralMapperEnvironment,
  NeutralMappingContext,
  StrictRemappingConfig,
  StrictRemappingConfigs,
  OperationProfileConfig,
} from "./core-types";
import { normalizeInstructionNeutral } from "./neutral";
import {
  mapInstructionWithConfigs,
  validateInstructionClassificationConfig,
  validateStrictRemappingConfigs,
} from "./strict";
import {
  mapKaminoKvaultOperationWithConfigs,
  validateOperationProfileConfig,
} from "./kvault-operation";
import {
  mapKaminoLendingRepayOperationWithConfigs,
  validateKlendOperationProfileConfig,
  type KlendOperationProfileConfig,
} from "./klend-operation";
import {
  mapKaminoFarmsStakeOperationWithConfigs,
  validateFarmsOperationProfileConfig,
  type FarmsOperationProfileConfig,
} from "./farms-operation";
import {
  mapJupiterEarnOperationWithConfigs,
  validateJupiterOperationProfileConfig,
  type JupiterOperationProfileConfig,
} from "./jupiter-operation";

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
  const kvaultOperationProfiles = validateOperationProfileConfig(
    KaminoKvauOperationProfiles as OperationProfileConfig,
    production,
    environment,
  );
  // Klend remains operation-only: these configs are deliberately excluded
  // from mapInstructionNeutral so a repay cannot bypass its required refresh
  // corpus and state bindings.
  const productionKlend: StrictRemappingConfigs =
    validateStrictRemappingConfigs(
      {
        [StrictKlendProgramConfig.program_id]:
          StrictKlendProgramConfig as StrictRemappingConfig,
      },
      environment,
    );
  const stagingKlend: StrictRemappingConfigs = validateStrictRemappingConfigs(
    {
      [StrictStagingKlendProgramConfig.program_id]:
        StrictStagingKlendProgramConfig as StrictRemappingConfig,
    },
    environment,
  );
  const productionKlendClassifications =
    validateInstructionClassificationConfig(
      KaminoLendingRepayClassifications as InstructionClassificationConfig,
      productionKlend,
      environment,
    );
  const stagingKlendClassifications = validateInstructionClassificationConfig(
    KaminoLendingRepayClassifications as InstructionClassificationConfig,
    stagingKlend,
    environment,
  );
  const klendOperationProfiles = validateKlendOperationProfileConfig(
    KaminoLendingRepayOperationProfiles as KlendOperationProfileConfig,
    productionKlend,
    environment,
  );
  // Farms stake is also operation-only: initialize_user and stake are usable
  // only after the complete selected sequence and decoded-state bindings pass.
  const productionFarms: StrictRemappingConfigs =
    validateStrictRemappingConfigs(
      {
        [StrictFarmsProgramConfig.program_id]:
          StrictFarmsProgramConfig as StrictRemappingConfig,
      },
      environment,
    );
  const stagingFarms: StrictRemappingConfigs = validateStrictRemappingConfigs(
    {
      [StrictStagingFarmsProgramConfig.program_id]:
        StrictStagingFarmsProgramConfig as StrictRemappingConfig,
    },
    environment,
  );
  const productionFarmsClassifications =
    validateInstructionClassificationConfig(
      KaminoFarmsStakeClassifications as InstructionClassificationConfig,
      productionFarms,
      environment,
    );
  const stagingFarmsClassifications = validateInstructionClassificationConfig(
    KaminoFarmsStakeClassifications as InstructionClassificationConfig,
    stagingFarms,
    environment,
  );
  const farmsOperationProfiles = validateFarmsOperationProfileConfig(
    KaminoFarmsStakeOperationProfiles as FarmsOperationProfileConfig,
    productionFarms,
    environment,
  );
  // Jupiter Earn remains operation-only. Both supported paths contain exactly
  // one bounded native instruction and require pre-existing vault ATAs.
  const productionJupiterEarn: StrictRemappingConfigs =
    validateStrictRemappingConfigs(
      {
        [StrictJupiterEarnProgramConfig.program_id]:
          StrictJupiterEarnProgramConfig as StrictRemappingConfig,
      },
      environment,
    );
  const stagingJupiterEarn: StrictRemappingConfigs =
    validateStrictRemappingConfigs(
      {
        [StrictStagingJupiterEarnProgramConfig.program_id]:
          StrictStagingJupiterEarnProgramConfig as StrictRemappingConfig,
      },
      environment,
    );
  const productionJupiterEarnClassifications =
    validateInstructionClassificationConfig(
      JupiterEarnClassifications as InstructionClassificationConfig,
      productionJupiterEarn,
      environment,
    );
  const stagingJupiterEarnClassifications =
    validateInstructionClassificationConfig(
      JupiterEarnClassifications as InstructionClassificationConfig,
      stagingJupiterEarn,
      environment,
    );
  const jupiterEarnOperationProfiles = validateJupiterOperationProfileConfig(
    JupiterEarnOperationProfiles as JupiterOperationProfileConfig,
    productionJupiterEarn,
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

  async function mapKaminoKvaultOperationNeutral(
    input: import("./core-types").MapKaminoKvaultOperationInput,
    context: NeutralMappingContext,
    options?: MapInstructionOptions,
  ): Promise<import("./core-types").NeutralMapOperationResult> {
    const useStaging = parseStaging(options);
    return mapKaminoKvaultOperationWithConfigs(
      input,
      context,
      useStaging ? staging : production,
      useStaging ? stagingClassifications : productionClassifications,
      kvaultOperationProfiles,
      environment,
    );
  }

  async function mapKaminoLendingRepayOperationNeutral(
    input: import("./core-types").MapKaminoLendingRepayOperationInput,
    context: NeutralMappingContext,
    options?: MapInstructionOptions,
  ): Promise<import("./core-types").NeutralMapOperationResult> {
    const useStaging = parseStaging(options);
    return mapKaminoLendingRepayOperationWithConfigs(
      input,
      context,
      useStaging ? stagingKlend : productionKlend,
      useStaging ? stagingKlendClassifications : productionKlendClassifications,
      klendOperationProfiles,
      environment,
    );
  }

  async function mapKaminoFarmsStakeOperationNeutral(
    input: import("./core-types").MapKaminoFarmsStakeOperationInput,
    context: NeutralMappingContext,
    options?: MapInstructionOptions,
  ): Promise<import("./core-types").NeutralMapOperationResult> {
    const useStaging = parseStaging(options);
    return mapKaminoFarmsStakeOperationWithConfigs(
      input,
      context,
      useStaging ? stagingFarms : productionFarms,
      useStaging
        ? stagingFarmsClassifications
        : productionFarmsClassifications,
      farmsOperationProfiles,
      environment,
    );
  }

  async function mapJupiterEarnOperationNeutral(
    input: import("./core-types").MapJupiterEarnOperationInput,
    context: NeutralMappingContext,
    options?: MapInstructionOptions,
  ): Promise<import("./core-types").NeutralMapOperationResult> {
    const useStaging = parseStaging(options);
    return mapJupiterEarnOperationWithConfigs(
      input,
      context,
      useStaging ? stagingJupiterEarn : productionJupiterEarn,
      useStaging
        ? stagingJupiterEarnClassifications
        : productionJupiterEarnClassifications,
      jupiterEarnOperationProfiles,
      environment,
    );
  }

  return {
    mapInstructionNeutral,
    mapInstructionsNeutral,
    mapKaminoKvaultOperationNeutral,
    mapKaminoLendingRepayOperationNeutral,
    mapKaminoFarmsStakeOperationNeutral,
    mapJupiterEarnOperationNeutral,
  } as const;
}

export { createNeutralMapper };
export type * from "./core-types";
/** Alias documenting direct structural compatibility with Solana Kit. */
export type { NeutralInstructionInput as SolanaKitInstruction } from "./core-types";
