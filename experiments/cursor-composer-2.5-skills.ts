import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals, sanityEvalEnv } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'cursor-composer-2.5',
  displayName: 'Cursor Composer 2.5',
  variant: 'skills',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'cursor',
  model: 'composer-2.5',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  env: sanityEvalEnv,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('cursor'),
  onRunComplete: redactSecrets,
};

export default config;
