import type { EvalFilter, SetupFunction } from '@vercel/agent-eval';
import { runPreCheckOnce } from '../../scripts/pre-check.ts';

export const sanityEvalEnv: Record<string, string> = {
  SANITY_INTERNAL_ENV: 'staging',
  SANITY_API_HOST: 'https://api.sanity.work',
};

// `mcp-smoketest` requires the Sanity MCP server to be configured, this filter excludes it from runners without MCP configured
export const nonMcpEvals: EvalFilter = (name) => name !== 'mcp-smoketest';

export const baseSetup: SetupFunction = async (sandbox) => {
  await runPreCheckOnce();
  const sanityAuthToken = process.env.SANITY_AUTH_TOKEN ?? 'placeholder';
  const dotEnv = [
    `SANITY_API_READ_TOKEN=placeholder`,
    `SANITY_AUTH_TOKEN=${sanityAuthToken}`,
    `SANITY_INTERNAL_ENV=${sanityEvalEnv.SANITY_INTERNAL_ENV}`,
    `SANITY_API_HOST=${sanityEvalEnv.SANITY_API_HOST}`,
    '',
  ].join('\n');
  await sandbox.writeFiles({ '.env': dotEnv });
};
