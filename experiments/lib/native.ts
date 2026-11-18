import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals, sanityEvalEnv } from './base-setup.ts';
import { redactSecrets } from './redact-secrets.ts';
import { createSanitySkillsSetup } from './sanity-skills-setup.ts';

/** Claude Code version the Claude Code lane installs (agent-eval would install the latest). */
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code@2.1.322';

/**
 * One native lane: a model in its maker's own coding agent (Claude on Claude Code, GPT on Codex), as Vercel's
 * next-evals does. Every lane bills the same OpenRouter key: our pnpm patch points agent-eval's Claude Code
 * adapter at OpenRouter's Anthropic API (https://openrouter.ai/api) and its Codex adapter at OpenRouter's
 * Responses API (https://openrouter.ai/api/v1). Same tasks, grading, timeout and redaction as the OpenCode
 * lane (openrouter.ts). The harness, its defaults and the model route differ between lanes, so a gap between
 * lanes is not by itself evidence about any one of them.
 *
 * The key reaches the agent only through its environment (the patch stops Codex saving it to
 * ~/.codex/auth.json and turns off Codex shell snapshots, which copy the environment into ~/.codex).
 * The Codex CLI version is pinned in the same patch.
 */
export function nativeExperiment(options: {
  harness: 'claude-code' | 'codex';
  model: string;
  skills?: boolean;
  skill?: string;
}): ExperimentConfig {
  return {
    agent: `openrouter/${options.harness}`,
    model: options.model,
    ...(options.harness === 'claude-code' ? { agentOptions: { cliPackage: CLAUDE_CODE_PACKAGE } } : {}),
    scripts: ['build'],
    runs: 3,
    earlyExit: false,
    // Grade in a fresh sandbox that gets only the agent's file changes.
    verifier: 'separate',
    timeout: 1800,
    sandbox: 'docker',
    // Claude Code's model roles are pinned in the adapter's auth env (our patch), not here: agentEnv values are
    // redacted as credentials, which would hide the model id in transcripts.
    agentEnv: sanityEvalEnv,
    evals: nonMcpEvals,
    setup: options.skill
      ? createSanitySkillsSetup(options.harness, options.skill)
      : options.skills
        ? createSanitySkillsSetup(options.harness)
        : baseSetup,
    onRunComplete: redactSecrets,
  };
}
