/**
 * The OpenCode config file lands in the agent's sandbox, where agents read it.
 * It must reference the key through the environment, never contain the key.
 * Uses the runner's own config generator (not exported, so loaded by path).
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { KEY_PLACEHOLDER, openRouterExperiment } from '../experiments/lib/openrouter.ts';

const require = createRequire(import.meta.url);
const agentEvalDir = dirname(require.resolve('@vercel/agent-eval/package.json'));
const { generateOpenCodeConfig } = await import(
  pathToFileURL(join(agentEvalDir, 'dist/lib/agents/opencode/agent.js')).href
);

const FAKE_KEY = 'sk-or-FAKE-MARKER-456';

test.each([false, true])('opencode.json never holds the literal key (skills=%s)', (skills) => {
  const config = openRouterExperiment({ model: 'anthropic/claude-haiku-5.5', skills });
  const extraProviders = (config.agentOptions as { extraProviders: Record<string, unknown> }).extraProviders;
  const written = generateOpenCodeConfig(extraProviders, FAKE_KEY, 1_800_000);
  expect(written).not.toContain(FAKE_KEY);
  const parsed = JSON.parse(written);
  expect(parsed.provider.vercel.options.apiKey).toBe(KEY_PLACEHOLDER);
  expect(parsed.provider.openrouter.options.apiKey).toBe(KEY_PLACEHOLDER);
});

test('without the override the runner would write the key (guards the test itself)', () => {
  expect(generateOpenCodeConfig({}, FAKE_KEY, 1_800_000)).toContain(FAKE_KEY);
});
