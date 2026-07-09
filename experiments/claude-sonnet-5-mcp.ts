import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup, sanityEvalEnv } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  variant: 'mcp',
  thinkingLevel: 'high',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-sonnet-5',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  env: sanityEvalEnv,
  agentOptions: { effort: 'high' },
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
