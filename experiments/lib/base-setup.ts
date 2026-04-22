import type { SetupFunction } from '@vercel/agent-eval';

export const baseSetup: SetupFunction = async (sandbox) => {
  const sanityAuthToken = process.env.SANITY_AUTH_TOKEN ?? 'placeholder';
  const dotEnv = [
    `SANITY_API_READ_TOKEN=placeholder`,
    `SANITY_AUTH_TOKEN=${sanityAuthToken}`,
    `SANITY_INTERNAL_ENV=staging`,
    '',
  ].join('\n');
  await sandbox.writeFiles({ '.env': dotEnv });
};
