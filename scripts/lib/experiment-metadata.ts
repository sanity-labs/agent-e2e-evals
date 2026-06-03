import { join } from 'node:path';
import { createJiti } from 'jiti';
import { z } from 'zod';
import {
  experimentMetadataSchema,
  type ExperimentMetadata,
  type ThinkingLevel,
  type VariantType,
} from '../../experiments/lib/experiment-metadata.js';

export type { ThinkingLevel, VariantType };

export interface LoadedExperimentMetadata {
  experimentName: string;
  agent: string;
  experimentMetadata: ExperimentMetadata;
}

// The experiment files have TS syntax that we can't import() directly, Jiti resolves that + is what agent-eval uses internally
const jiti = createJiti(import.meta.url, {
  interopDefault: false,
  moduleCache: false,
});

const experimentConfigSchema = z.looseObject({ agent: z.string() });
const experimentModuleSchema = z.looseObject({ default: experimentConfigSchema });

export function validateExperimentModule(module: unknown, experimentName: string): LoadedExperimentMetadata {
  const result = experimentModuleSchema.parse(module);

  return {
    experimentName,
    agent: result.default.agent,
    experimentMetadata: experimentMetadataSchema.parse(result.experimentMetadata),
  };
}

export async function loadExperimentMetadata(
  experimentsDir: string,
  experimentName: string,
): Promise<LoadedExperimentMetadata> {
  const experimentPath = join(experimentsDir, `${experimentName}.ts`);
  const module = await jiti.import(experimentPath);
  return validateExperimentModule(module, experimentName);
}
