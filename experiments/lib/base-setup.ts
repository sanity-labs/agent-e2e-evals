import type { SetupFunction } from '@vercel/agent-eval';

// Evals that need a Sanity read token only require it to be set (the build
// fails at module evaluation if the var is missing). The agents write code but
// don't actually query Sanity during build, so a placeholder is sufficient.
const dotEnv = 'SANITY_API_READ_TOKEN=placeholder\n';

export const baseSetup: SetupFunction = async (sandbox) => {
  await sandbox.writeFiles({ '.env': dotEnv });
};
