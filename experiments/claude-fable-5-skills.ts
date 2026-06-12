import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  variant: 'skills',
  thinkingLevel: 'high',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-fable-5',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  agentOptions: { effort: 'high' },
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('claude-code'),
  onRunComplete: redactSecrets,
};

export default config;
