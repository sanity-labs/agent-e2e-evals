import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  variant: 'mcp',
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
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
