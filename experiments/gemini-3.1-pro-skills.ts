import type { ExperimentConfig } from '@vercel/agent-eval';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'gemini-3.1-pro',
  displayName: 'Gemini 3.1 Pro',
  variant: 'skills',
} satisfies ExperimentMetadata;

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
