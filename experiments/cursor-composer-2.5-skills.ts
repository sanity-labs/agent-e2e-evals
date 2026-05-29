import type { ExperimentConfig } from '@vercel/agent-eval';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'cursor',
  model: 'composer-2.5',
  scripts: ['build'],
  runs: 8,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('cursor'),
  onRunComplete: redactSecrets,
};

export default config;
