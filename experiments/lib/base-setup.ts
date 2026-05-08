import type { EvalFilter, SetupFunction } from '@vercel/agent-eval';

// `mcp-smoketest` requires the Sanity MCP server to be configured, this filter excludes it from runners without MCP configured
export const nonMcpEvals: EvalFilter = (name) => name !== 'mcp-smoketest';

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
