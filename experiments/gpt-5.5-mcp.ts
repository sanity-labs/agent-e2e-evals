import type { ExperimentConfig } from '@vercel/agent-eval';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.5',
  scripts: ['build'],
  runs: 25,
  earlyExit: false,
  timeout: 1800,
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
