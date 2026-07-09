import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals, sanityEvalEnv } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'claude-opus-4.8',
  displayName: 'Claude Opus 4.8',
  variant: 'skills',
  thinkingLevel: 'high',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-8',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  env: sanityEvalEnv,
  agentOptions: { effort: 'high' },
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('claude-code'),
  onRunComplete: redactSecrets,
};

export default config;
