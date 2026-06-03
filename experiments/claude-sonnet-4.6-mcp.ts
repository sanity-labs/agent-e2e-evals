import type { ExperimentConfig } from '@vercel/agent-eval';
import { redactSecrets } from './lib/redact-secrets.js';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-sonnet-4-6',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  agentOptions: { effort: 'high' },
  setup: sanityMcpSetup,
  onRunComplete: redactSecrets,
};

export default config;
