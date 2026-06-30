import type { ExperimentConfig } from '@vercel/agent-eval';
import type { ExperimentMetadata } from './lib/experiment-metadata.js';
import { withGeminiWorkspaceTrust } from './lib/gemini-trust-setup.js';
import { redactSecrets } from './lib/redact-secrets.js';
import { createSanitySkillsSetup, nonMcpEvals } from './lib/sanity-skills-setup.js';

export const experimentMetadata = {
  modelName: 'gemini-3.5-flash',
  displayName: 'Gemini 3.5 Flash',
  variant: 'skills',
} satisfies ExperimentMetadata;

const config: ExperimentConfig = {
  agent: 'gemini',
  model: 'gemini-3.5-flash',
  scripts: ['build'],
  runs: 16,
  earlyExit: false,
  timeout: 1800,
  evals: nonMcpEvals,
  setup: withGeminiWorkspaceTrust(createSanitySkillsSetup('gemini')),
  onRunComplete: redactSecrets,
};

export default config;
