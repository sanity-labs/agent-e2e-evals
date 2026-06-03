import type { ExperimentConfig } from '@vercel/agent-eval';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.5?reasoningEffort=medium',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('codex'),
  onRunComplete: redactSecrets,
};

export default config;
