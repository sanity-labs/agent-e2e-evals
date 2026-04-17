import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup } from './lib/base-setup.js';

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-5',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 720,
  setup: baseSetup,
};

export default config;
