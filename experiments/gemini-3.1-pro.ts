import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals } from './lib/base-setup.js';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';

const config: ExperimentConfig = {
  agent: 'gemini',
  model: 'gemini-3.1-pro-preview',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: withGeminiWorkspaceTrust(baseSetup),
  onRunComplete: redactSecrets,
};

export default config;
