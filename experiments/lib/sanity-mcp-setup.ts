import type { SetupFunction } from '@vercel/agent-eval';
import { baseSetup } from './base-setup.js';

const token = process.env.SANITY_AUTH_TOKEN;
const mcpUrl = process.env.SANITY_MCP_URL || 'https://mcp.sanity.io/';
const disabledTools = ['list_sanity_rules', 'get_sanity_rules'];

if (!token) {
  throw new Error('SANITY_AUTH_TOKEN environment variable is required for MCP experiments');
}

const claudeMcpJson = JSON.stringify(
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

const claudeSettingsJson = JSON.stringify(
  {
    permissions: {
      deny: disabledTools.map((tool) => `mcp__sanity__${tool}`),
    },
  },
  null,
  2,
);

const cursorMcpJson = JSON.stringify(
  {
    mcpServers: {
      sanity: {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote@latest',
          mcpUrl,
          '--header',
          `Authorization: Bearer ${token}`,
          ...disabledTools.flatMap((tool) => ['--ignore-tool', tool]),
        ],
      },
    },
  },
  null,
  2,
);

const geminiSettingsJson = JSON.stringify(
  {
    mcpServers: {
      sanity: {
        httpUrl: mcpUrl,
        headers: {
          Authorization: `Bearer ${token}`,
        },
        trust: true,
        excludeTools: disabledTools,
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
  `disabled_tools = [${disabledTools.map((tool) => `"${tool}"`).join(', ')}]`,
  'required = true',
  '',
].join('\n');

export const sanityMcpSetup: SetupFunction = async (sandbox) => {
  await baseSetup(sandbox);

  // Claude Code: .mcp.json in project root
  await sandbox.writeFiles({ '.mcp.json': claudeMcpJson });
  await sandbox.runCommand('mkdir', ['-p', '.claude']);
  await sandbox.writeFiles({ '.claude/settings.json': claudeSettingsJson });

  // Cursor: .cursor/mcp.json in project root
  await sandbox.runCommand('mkdir', ['-p', '.cursor']);
  await sandbox.writeFiles({ '.cursor/mcp.json': cursorMcpJson });

  // Gemini CLI: .gemini/settings.json in project root
  await sandbox.runCommand('mkdir', ['-p', '.gemini']);
  await sandbox.writeFiles({ '.gemini/settings.json': geminiSettingsJson });

  // Codex: append MCP config to ~/.codex/config.toml (user-level, always loaded regardless of project trust)
  await sandbox.runCommand('bash', ['-c', 'mkdir -p ~/.codex']);
  await sandbox.runCommand('bash', ['-c', `cat >> ~/.codex/config.toml << 'EOF'\n${codexMcpToml}\nEOF`]);
};
