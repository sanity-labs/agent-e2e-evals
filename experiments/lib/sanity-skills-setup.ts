import type { SetupFunction } from '@vercel/agent-eval';
import { baseSetup, nonMcpEvals } from './base-setup.js';

export { nonMcpEvals };

export function createSanitySkillsSetup(agent: string): SetupFunction {
  return async (sandbox) => {
    await baseSetup(sandbox);

    await sandbox.runCommand('npx', [
      '-y',
      'skills',
      'add',
      'sanity-io/agent-toolkit',
      '--agent',
      agent,
      '--skill',
      '*',
      '--yes',
    ]);
  };
}
