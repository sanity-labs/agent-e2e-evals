import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals, sanityEvalEnv } from './base-setup.ts';
import { redactSecrets } from './redact-secrets.ts';
import { createSanitySkillsSetup } from './sanity-skills-setup.ts';

/**
 * One OpenRouter lane: every model runs in the same harness (OpenCode) so the
 * model is the main thing that changes between configs.
 *
 * @vercel/agent-eval's OpenCode adapter only knows the Vercel AI Gateway: it puts
 * the run's API key in AI_GATEWAY_API_KEY. We hand it the OpenRouter key instead
 * and point OpenCode's built-in `openrouter` provider at that variable, so no
 * adapter fork is needed. The key is still the run's `apiKey`, so the runner's
 * own redaction covers it.
 *
 * The adapter also writes the literal key into opencode.json's `vercel`
 * provider, which agents read during runs (29 Oct audit). Overriding that field
 * with the env placeholder keeps the literal key out of the file. The key is
 * still in the agent's environment, so use a capped, per-batch key.
 */
export const KEY_PLACEHOLDER = '{env:AI_GATEWAY_API_KEY}';

export function openRouterExperiment(options: { model: string; skills?: boolean }): ExperimentConfig {
  return {
    agent: 'vercel-ai-gateway/opencode',
    model: `openrouter/${options.model}`,
    agentOptions: {
      extraProviders: {
        openrouter: { options: { apiKey: KEY_PLACEHOLDER } },
        vercel: { options: { apiKey: KEY_PLACEHOLDER } },
      },
    },
    scripts: ['build'],
    runs: 3,
    earlyExit: false,
    // Grade in a fresh sandbox that gets only the agent's file changes.
    verifier: 'separate',
    timeout: 1800,
    sandbox: 'docker',
    agentEnv: sanityEvalEnv,
    evals: nonMcpEvals,
    setup: options.skills ? createSanitySkillsSetup('opencode') : baseSetup,
    onRunComplete: redactSecrets,
  };
}
