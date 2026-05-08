import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals } from './lib/base-setup.js';

const config: ExperimentConfig = {
  agent: 'cursor',
  model: 'composer-2',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 720,
  evals: nonMcpEvals,
  setup: baseSetup,
};

export default config;
