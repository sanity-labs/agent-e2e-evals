import type { ExperimentConfig } from '@vercel/agent-eval';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'gemini',
  model: 'gemini-3.5-flash',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  setup: withGeminiWorkspaceTrust(sanityMcpSetup),
  onRunComplete: redactSecrets,
};

export default config;
