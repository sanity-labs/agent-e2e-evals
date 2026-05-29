import type { ExperimentConfig } from '@vercel/agent-eval';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'codex',
  model: 'gpt-5.4',
  scripts: ['build'],
  runs: 4,
  earlyExit: false,
  timeout: 1200,
  evals: nonMcpEvals,
  setup: createSanitySkillsSetup('codex'),
};

export default config;
