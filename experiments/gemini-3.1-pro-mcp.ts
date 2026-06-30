import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

export const experimentMetadata = {
  modelName: 'gemini-3.1-pro',
  displayName: 'Gemini 3.1 Pro',
  variant: 'mcp',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'gemini',
  model: 'gemini-3.1-pro-preview',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  setup: withGeminiWorkspaceTrust(sanityMcpSetup),
  onRunComplete: redactSecrets,
};

export default config;
