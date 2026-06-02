import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals } from './lib/base-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.3-codex',
  scripts: ['build'],
  runs: 25,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: baseSetup,
  onRunComplete: redactSecrets,
};

export default config;
