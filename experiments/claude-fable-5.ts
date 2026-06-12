import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals } from './lib/base-setup.js';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';

export const experimentMetadata = {
  modelName: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  variant: 'baseline',
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
  setup: baseSetup,
  onRunComplete: redactSecrets,
};

export default config;
