import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals, sanityEvalEnv } from './lib/base-setup.js';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';

export const experimentMetadata = {
  modelName: 'gpt-5.6-terra',
  displayName: 'GPT-5.6 Terra',
  variant: 'baseline',
  thinkingLevel: 'xhigh',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.6-terra?reasoningEffort=xhigh',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  env: sanityEvalEnv,
  evals: nonMcpEvals,
  setup: baseSetup,
  onRunComplete: redactSecrets,
};

export default config;
