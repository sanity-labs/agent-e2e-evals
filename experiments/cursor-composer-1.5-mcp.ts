import type { ExperimentConfig } from '@vercel/agent-eval';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'cursor',
  model: 'composer-1.5',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 1200,
  setup: sanityMcpSetup,
};

export default config;
