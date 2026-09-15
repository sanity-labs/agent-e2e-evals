import type { SetupFunction } from '@vercel/agent-eval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseSetup } from './base-setup.js';
import { sanityMcpSetup } from './sanity-mcp-setup.js';
import { createSanitySkillsSetup } from './sanity-skills-setup.js';

vi.mock('./base-setup.js', () => ({
  baseSetup: vi.fn().mockResolvedValue(undefined),
  nonMcpEvals: vi.fn(),
  sanityEvalEnv: {},
}));

function createSandbox() {
  const files: Record<string, string> = {};
  const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  const sandbox = {
    writeFiles: vi.fn(async (written: Record<string, string>) => {
      Object.assign(files, written);
    }),
    runCommand,
  } as unknown as Parameters<SetupFunction>[0];
  return { sandbox, files, runCommand };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SANITY_AUTH_TOKEN', 'test-token');
  vi.stubEnv('SANITY_MCP_URL', '');
  vi.stubEnv('SANITY_SKILLS_BRANCH', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('skills source selection', () => {
  it.each(['claude-code', 'codex', 'cursor', 'gemini-cli'])('keeps the default source for %s', async (agent) => {
    const { sandbox, runCommand } = createSandbox();
    await createSanitySkillsSetup(agent)(sandbox);

    expect(baseSetup).toHaveBeenCalledWith(sandbox);
    expect(runCommand).toHaveBeenCalledWith('npx', [
      '-y',
      'skills@1.5.26',
      'add',
      'sanity-io/agent-toolkit',
      '--agent',
      agent,
      '--skill',
      'sanity-best-practices',
      '--yes',
    ]);
  });

  it.each([
    ['main', 'main'],
    ['fix/groq-guidance', 'fix%2Fgroq-guidance'],
    ['test@branch#with-percent%', 'test%40branch%23with-percent%25'],
    ['  fix/groq-guidance  ', 'fix%2Fgroq-guidance'],
  ])('selects the complete branch %s', async (branch, encoded) => {
    vi.stubEnv('SANITY_SKILLS_BRANCH', branch);
    const { sandbox, runCommand } = createSandbox();
    await createSanitySkillsSetup('codex')(sandbox);
    expect(runCommand.mock.calls[0]?.[1]).toContain(`sanity-io/agent-toolkit#${encoded}`);
  });

  it('uses the default branch for a blank override', async () => {
    vi.stubEnv('SANITY_SKILLS_BRANCH', '   ');
    const { sandbox, runCommand } = createSandbox();
    await createSanitySkillsSetup('codex')(sandbox);
    expect(runCommand.mock.calls[0]?.[1]).toContain('sanity-io/agent-toolkit');
  });

  it.each([
    { exitCode: 1, stderr: 'Remote branch missing not found', stdout: '' },
    { exitCode: 1, stderr: '', stdout: 'No matching skills found' },
  ])('fails setup when the installer fails: $stderr$stdout', async (result) => {
    vi.stubEnv('SANITY_SKILLS_BRANCH', 'missing');
    const { sandbox, runCommand } = createSandbox();
    runCommand.mockResolvedValue(result);
    await expect(createSanitySkillsSetup('codex')(sandbox)).rejects.toThrow(
      `Failed to install Sanity skills from sanity-io/agent-toolkit#missing: ${result.stderr || result.stdout}`,
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe('MCP endpoint selection', () => {
  it.each([
    ['', 'https://mcp.sanity.io/'],
    ['https://branch.sanity.work/mcp', 'https://branch.sanity.work/mcp'],
    ['https://branch.sanity.work/mcp?label="quoted"', 'https://branch.sanity.work/mcp?label="quoted"'],
  ])('writes the selected endpoint to all four clients: %s', async (override, expected) => {
    vi.stubEnv('SANITY_MCP_URL', override);
    const { sandbox, files, runCommand } = createSandbox();
    await sanityMcpSetup(sandbox);

    expect(baseSetup).toHaveBeenCalledWith(sandbox);
    const claude = JSON.parse(files['.mcp.json']!).mcpServers.sanity;
    expect(claude.url).toBe(expected);
    expect(claude.headers.Authorization).toBe('Bearer test-token');
    const cursor = JSON.parse(files['.cursor/mcp.json']!).mcpServers.sanity;
    expect(cursor.args).toContain(expected);
    expect(cursor.args).toContain('Authorization: Bearer test-token');
    const gemini = JSON.parse(files['.gemini/settings.json']!).mcpServers.sanity;
    expect(gemini.httpUrl).toBe(expected);
    expect(gemini.headers.Authorization).toBe('Bearer test-token');
    const codexCommand = runCommand.mock.calls.at(-1)?.[1][1] as string;
    expect(codexCommand).toContain(`url = ${JSON.stringify(expected)}\n`);
    expect(codexCommand).toContain('http_headers = { "Authorization" = "Bearer test-token" }');
  });

  it('requires authentication before writing MCP config', async () => {
    vi.stubEnv('SANITY_AUTH_TOKEN', '');
    const { sandbox, files, runCommand } = createSandbox();
    await expect(sanityMcpSetup(sandbox)).rejects.toThrow('SANITY_AUTH_TOKEN');
    expect(files).toEqual({});
    expect(runCommand).not.toHaveBeenCalled();
  });
});
