import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup, sanityEvalEnv } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'gpt-5.6-luna',
  displayName: 'GPT-5.6 Luna',
  variant: 'mcp',
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
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
