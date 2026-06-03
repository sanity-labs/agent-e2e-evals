import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals } from './lib/base-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-6',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  agentOptions: { effort: 'high' },
  evals: nonMcpEvals,
  setup: baseSetup,
  onRunComplete: redactSecrets,
};

export default config;
