import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'cursor-composer-2.5',
  displayName: 'Cursor Composer 2.5',
  variant: 'mcp',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'cursor',
  model: 'composer-2.5',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
