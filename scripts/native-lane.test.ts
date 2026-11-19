/**
 * Native lanes bill the OpenRouter key for the model under test only: the patched Claude Code adapter pins every
 * model role to that model, and neither lane points anywhere but OpenRouter.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { nativeExperiment } from '../experiments/lib/native.ts';

const agents = join(
  dirname(createRequire(import.meta.url).resolve('@vercel/agent-eval/package.json')),
  'dist/lib/agents',
);
const load = (file: string) => import(pathToFileURL(join(agents, file)).href);
const { createClaudeCodeDefinition } = await load('claude-code/agent.js');
const { createCodexDefinition } = await load('codex/agent.js');
const { assertAgentEnv } = await load('plugin/orchestrator.js');
const MODEL = 'anthropic/claude-sonnet-5.5';

test('Claude Code on OpenRouter pins every model role to the model under test, outside agentEnv', () => {
  const env = createClaudeCodeDefinition({ useVercelAiGateway: true }).authEnv({ apiKey: 'k', model: MODEL });
  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_AUTH_TOKEN: 'k',
    ANTHROPIC_API_KEY: '',
  });
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ])
    expect(env[key], key).toBe(MODEL);
  expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  // agentEnv values are redacted as credentials: the model id must not be one, or transcripts lose it.
  expect(Object.values(nativeExperiment({ harness: 'claude-code', model: MODEL }).agentEnv ?? {})).not.toContain(MODEL);
});

test.each([
  ['claude-code', createClaudeCodeDefinition],
  ['codex', createCodexDefinition],
] as const)(
  "the %s experiment passes agent-eval's agentEnv check (no key reserved for the adapter)",
  (harness, create) => {
    const config = nativeExperiment({ harness, model: MODEL });
    expect(() =>
      assertAgentEnv(create({ useVercelAiGateway: true }), { apiKey: 'k', model: MODEL, agentEnv: config.agentEnv }),
    ).not.toThrow();
  },
);

test('both native lanes use the OpenRouter adapters', () => {
  expect(nativeExperiment({ harness: 'claude-code', model: 'x' }).agent).toBe('openrouter/claude-code');
  expect(nativeExperiment({ harness: 'codex', model: 'x' }).agent).toBe('openrouter/codex');
});
