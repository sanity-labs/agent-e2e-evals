import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup } from './lib/base-setup.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.2-codex',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 720,
  setup: baseSetup,
};

export default config;
