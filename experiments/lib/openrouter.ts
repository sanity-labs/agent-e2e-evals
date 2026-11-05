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
 * The adapter would also write the literal key into opencode.json's `vercel`
 * provider, a file the agent can read. Overriding that field with the env
 * placeholder keeps the literal key out of the file. The key is still in the
 * agent's environment, so use a capped, per-batch key.
 */
const KEY_PLACEHOLDER = '{env:AI_GATEWAY_API_KEY}';

/**
 * OpenCode config merged on top of the generated opencode.json (OpenCode reads
 * OPENCODE_CONFIG_CONTENT as local config). Snapshots off: with them on, OpenCode
 * diffs the whole tree from the session start after every step, in-process. Once
 * an agent reinstalls dependencies (~12k changed package-lock.json lines in the
 * Studio upgrade) that costs ~85 s of CPU per step and attempts hit the timeout.
 * The prompt and grader are unchanged and grading uses agent-eval's own changed-file
 * record, but OpenCode's behaviour isn't proven identical either way, so results are
 * labelled with this setting. Evidence: evals/upgrade/receipts.
 */
const OPENCODE_CONFIG_CONTENT = JSON.stringify({ snapshot: false });

/**
 * `skills` installs Sanity's best-practices skill; `skill` names a different agent-toolkit skill instead.
 * `promptSuffix` adds one paragraph to the end of the task prompt, unchanged (a docs-hint test arm).
 */
export function openRouterExperiment(options: {
  model: string;
  skills?: boolean;
  skill?: string;
  promptSuffix?: string;
}): ExperimentConfig {
  const { promptSuffix } = options;
  return {
    ...(promptSuffix ? { editPrompt: (prompt: string) => `${prompt.trimEnd()}\n\n${promptSuffix}\n` } : {}),
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
    agentEnv: { ...sanityEvalEnv, OPENCODE_CONFIG_CONTENT },
    evals: nonMcpEvals,
    setup: options.skill
      ? createSanitySkillsSetup('opencode', options.skill)
      : options.skills
        ? createSanitySkillsSetup('opencode')
        : baseSetup,
    onRunComplete: redactSecrets,
  };
}
