import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals, sanityEvalEnv } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'gpt-5.6-luna',
  displayName: 'GPT-5.6 Luna',
  variant: 'skills',
  thinkingLevel: 'xhigh',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.6-luna?reasoningEffort=xhigh',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  env: sanityEvalEnv,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('codex'),
  onRunComplete: redactSecrets,
};

export default config;
