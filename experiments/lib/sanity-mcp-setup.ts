import type { SetupFunction } from '@vercel/agent-eval';
import { baseSetup } from './base-setup.js';

const token = process.env.SANITY_AUTH_TOKEN;
const mcpUrl = process.env.SANITY_MCP_URL || 'https://mcp.sanity.io/';

if (!token) {
  throw new Error('SANITY_AUTH_TOKEN environment variable is required for MCP experiments');
}

const mcpJson = JSON.stringify(
  {
    mcpServers: {
      sanity: {
        type: 'http',
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  },
  null,
  2,
);

const codexMcpToml = [
  '',
  '[mcp_servers.sanity]',
  `url = "${mcpUrl}"`,
  `http_headers = { "Authorization" = "Bearer ${token}" }`,
  'required = true',
  '',
].join('\n');

export const sanityMcpSetup: SetupFunction = async (sandbox) => {
  await baseSetup(sandbox);

  // Claude Code: .mcp.json in project root
  await sandbox.writeFiles({ '.mcp.json': mcpJson });

  // Cursor: .cursor/mcp.json in project root
  await sandbox.runCommand('mkdir', ['-p', '.cursor']);
  await sandbox.writeFiles({ '.cursor/mcp.json': mcpJson });

  // Codex: ~/.codex/config.toml (use bash -c because writeFiles can't write to /root in Vercel Sandbox)
  await sandbox.runCommand('bash', [
    '-c',
    `mkdir -p ~/.codex && cat >> ~/.codex/config.toml << 'MCPEOF'\n${codexMcpToml}\nMCPEOF`,
  ]);
};
