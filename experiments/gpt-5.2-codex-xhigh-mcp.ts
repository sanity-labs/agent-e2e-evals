import type { ExperimentConfig } from '@vercel/agent-eval';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.2-codex?reasoningEffort=xhigh',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 1200,
  setup: sanityMcpSetup,
};

export default config;
