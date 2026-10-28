import type { ExperimentMetadata } from './lib/experiment-metadata.ts';
import { openRouterExperiment } from './lib/openrouter.ts';

export const experimentMetadata = {
  modelName: 'claude-haiku-5.5',
  displayName: 'Claude Haiku 5.5',
  variant: 'skills',
} satisfies ExperimentMetadata;

export default openRouterExperiment({ model: 'anthropic/claude-haiku-5.5', skills: true });
