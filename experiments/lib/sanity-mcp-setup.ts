import type { ExperimentConfig } from '@vercel/agent-eval';

const token = process.env.SANITY_AUTH_TOKEN;
const mcpUrl = process.env.SANITY_MCP_URL || 'https://mcp.sanity.io/';

if (!token) {
  throw new Error('SANITY_AUTH_TOKEN environment variable is required for MCP experiments');
}

export const sanityMcpSetup: ExperimentConfig['setup'] = async (sandbox) => {
  await sandbox.writeFiles({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        sanity: {
          type: 'http',
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    }, null, 2),
  });
};
