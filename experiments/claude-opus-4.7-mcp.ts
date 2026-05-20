import type { ExperimentConfig } from '@vercel/agent-eval';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-7',
  scripts: ['build'],
  runs: 4,
  earlyExit: false,
  timeout: 1200,
  setup: sanityMcpSetup,
};

export default config;
