import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'gpt-5.5',
  displayName: 'GPT-5.5',
  variant: 'skills',
  thinkingLevel: 'medium',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.5?reasoningEffort=medium',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('codex'),
  onRunComplete: redactSecrets,
};

export default config;
