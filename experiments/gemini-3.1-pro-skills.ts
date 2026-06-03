import type { ExperimentConfig } from '@vercel/agent-eval';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'gemini',
  model: 'gemini-3.1-pro-preview',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: withGeminiWorkspaceTrust(createSanitySkillsSetup('gemini')),
  onRunComplete: redactSecrets,
};

export default config;
