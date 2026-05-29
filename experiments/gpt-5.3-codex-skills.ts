import type { ExperimentConfig } from '@vercel/agent-eval';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.3-codex',
  scripts: ['build'],
  runs: 8,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('codex'),
};

export default config;
