import type { SetupFunction } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals, sanityEvalEnv } from './base-setup.js';

export { nonMcpEvals, sanityEvalEnv };

export function createSanitySkillsSetup(agent: string): SetupFunction {
  return async (sandbox) => {
    await baseSetup(sandbox);

    const branch = process.env.SANITY_SKILLS_BRANCH?.trim();
    const source = branch ? `sanity-io/agent-toolkit#${encodeURIComponent(branch)}` : 'sanity-io/agent-toolkit';

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
