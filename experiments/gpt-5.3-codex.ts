import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.3-codex',
  scripts: ['build'],
  runs: 4,
  earlyExit: true,
  timeout: 720,
};

export default config;
