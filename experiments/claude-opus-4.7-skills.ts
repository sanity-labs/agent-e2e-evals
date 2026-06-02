import type { ExperimentConfig } from '@vercel/agent-eval';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'claude-code',
  model: 'claude-opus-4-7',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('claude-code'),
  onRunComplete: redactSecrets,
};

export default config;
