import type { ExperimentConfig } from '@vercel/agent-eval';

const token = process.env.SANITY_AUTH_TOKEN;
const mcpUrl = process.env.SANITY_MCP_URL || 'https://mcp.sanity.io/';

if (!token) {
  throw new Error('SANITY_AUTH_TOKEN environment variable is required for MCP experiments');
}

const mcpJson = JSON.stringify({
  mcpServers: {
    sanity: {
      type: 'http',
      url: mcpUrl,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  },
}, null, 2);

const codexMcpToml = [
  '',
  '[mcp_servers.sanity]',
  `url = "${mcpUrl}"`,
  `http_headers = { "Authorization" = "Bearer ${token}" }`,
  'required = true',
  '',
].join('\n');

export const sanityMcpSetup: ExperimentConfig['setup'] = async (sandbox) => {
  // Claude Code: .mcp.json in project root
  await sandbox.writeFiles({ '.mcp.json': mcpJson });

  // Cursor: .cursor/mcp.json in project root
  await sandbox.runCommand('mkdir', ['-p', '.cursor']);
  await sandbox.writeFiles({ '.cursor/mcp.json': mcpJson });

  // Codex: use inotifywait to append MCP config after the framework
  // overwrites ~/.codex/config.toml. The watcher runs in the background
  // and triggers once when the file is written.
  await sandbox.writeFiles({ '/tmp/sanity-mcp.toml': codexMcpToml });
  await sandbox.runCommand('mkdir', ['-p', '/root/.codex']);

  // Install inotify-tools and start a background watcher
  await sandbox.runCommand('sh', ['-c',
    'apt-get update -qq && apt-get install -y -qq inotify-tools > /dev/null 2>&1'
  ]);
  await sandbox.runCommand('sh', ['-c', [
    'nohup sh -c \'',
    'inotifywait -e close_write /root/.codex/config.toml 2>/dev/null;',
    'cat /tmp/sanity-mcp.toml >> /root/.codex/config.toml',
    '\' > /dev/null 2>&1 &',
  ].join(' ')]);
};
