import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'claude-opus-4.6',
  displayName: 'Claude Opus 4.6',
  variant: 'mcp',
  thinkingLevel: 'high',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-6',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  agentOptions: { effort: 'high' },
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
