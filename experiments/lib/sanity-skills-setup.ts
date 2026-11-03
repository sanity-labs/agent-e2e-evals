import type { SetupFunction } from '@vercel/agent-eval';
import { baseSetup } from './base-setup.ts';

/**
 * The agent-toolkit commit every skills cell installs, so all cells see the same guidance.
 * SANITY_SKILLS_BRANCH overrides it (a branch, tag or commit); run.ts records the value used.
 */
export const SKILLS_REF = process.env.SANITY_SKILLS_BRANCH?.trim() || '3ed3a143f8d3413faa7790ac0b2274fd3a8a6320';

/**
 * "Added installed guidance": installs one Sanity skill (best practices by default) for the given agent
 * before it starts. The experiment file name says which skill a cell installs.
 */
export function createSanitySkillsSetup(agent: string, skill = 'sanity-best-practices'): SetupFunction {
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
      skill,
      '--yes',
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to install Sanity skill ${skill} from ${source}: ${result.stderr || result.stdout}`);
    }
  };
}
