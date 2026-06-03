import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'gpt-5.3-codex',
  displayName: 'GPT-5.3 Codex',
  variant: 'mcp',
  thinkingLevel: 'medium',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.3-codex?reasoningEffort=medium',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
