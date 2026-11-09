import type { EvalFilter, SetupFunction } from '@vercel/agent-eval';

/** Sanity staging API, so eval runs never touch production projects. */
export const sanityEvalEnv: Record<string, string> = {
  SANITY_INTERNAL_ENV: 'staging',
  SANITY_API_HOST: 'https://api.sanity.work',
};

/** `mcp-smoketest` needs the Sanity MCP server, which the OpenRouter lane does not configure yet. */
export const nonMcpEvals: EvalFilter = (name) => name !== 'mcp-smoketest';

/** Writes the .env the task fixtures expect, placeholders only: the same setup runs in the agent sandbox and the separate verifier, so the host token is never written into either. */
export const baseSetup: SetupFunction = async (sandbox) => {
  const dotEnv = [
    'SANITY_API_READ_TOKEN=placeholder',
    'SANITY_AUTH_TOKEN=placeholder',
    `SANITY_INTERNAL_ENV=${sanityEvalEnv.SANITY_INTERNAL_ENV}`,
    `SANITY_API_HOST=${sanityEvalEnv.SANITY_API_HOST}`,
    '',
  ].join('\n');
  await sandbox.writeFiles({ '.env': dotEnv });
};
