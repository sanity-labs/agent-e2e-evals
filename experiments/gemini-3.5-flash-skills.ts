import type { ExperimentConfig } from '@vercel/agent-eval';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

const config: ExperimentConfig = {
  agent: 'gemini',
  model: 'gemini-3.5-flash',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: withGeminiWorkspaceTrust(createSanitySkillsSetup('gemini')),
};

export default config;
