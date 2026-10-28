import type { SetupFunction } from '@vercel/agent-eval';
import { baseSetup } from './base-setup.ts';

/**
 * The agent-toolkit commit every skills cell installs, so all cells see the same guidance.
 * SANITY_SKILLS_BRANCH overrides it (a branch, tag or commit); run.ts records the value used.
 */
export const SKILLS_REF = process.env.SANITY_SKILLS_BRANCH?.trim() || '3ed3a143f8d3413faa7790ac0b2274fd3a8a6320';

/** "Added installed guidance": installs Sanity's best-practices skill for the given agent before it starts. */
export function createSanitySkillsSetup(agent: string): SetupFunction {
  return async (sandbox) => {
    await baseSetup(sandbox);

    const source = `sanity-io/agent-toolkit#${encodeURIComponent(SKILLS_REF)}`;

    const result = await sandbox.runCommand('npx', [
      '-y',
      'skills@1.5.26',
      'add',
      source,
      '--agent',
      agent,
      '--skill',
      'sanity-best-practices',
      '--yes',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to install Sanity skills from ${source}: ${result.stderr || result.stdout}`);
    }
  };
}
