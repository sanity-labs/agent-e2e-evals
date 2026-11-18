/**
 * The Codex config file lands in the agent's sandbox, where agents read it. On our lane it must
 * point at OpenRouter's Responses API, take the key from the environment, never contain the key, and turn
 * off shell snapshots (they copy the environment, key included, into ~/.codex while the agent runs).
 * Uses the runner's own config generator, loaded by path.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const agentEvalDir = dirname(require.resolve('@vercel/agent-eval/package.json'));
const { generateCodexConfig } = await import(pathToFileURL(join(agentEvalDir, 'dist/lib/agents/codex/agent.js')).href);

test.each(['openai/gpt-5.6-terra', 'gpt-5.5'])(
  'OpenRouter config for %s keeps the key out and snapshots off',
  (model) => {
    const written: string = generateCodexConfig(model, true, undefined, false, false);
    expect(written).toContain('model_provider = "openrouter"');
    expect(written).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(written).toContain('env_key = "OPENROUTER_API_KEY"');
    expect(written).toContain('wire_api = "responses"');
    expect(written).not.toContain('ai-gateway');
    expect(written).not.toMatch(/vck_|sk-|Bearer/);
    // OpenRouter needs the provider prefix.
    expect(written).toContain('model = "openai/');
    expect(written).toMatch(/\n\[features\]\nshell_snapshot = false\n/);
    // [features] must come after every top-level key, or TOML would file those keys under it.
    expect(written.indexOf('[features]')).toBeGreaterThan(written.lastIndexOf('model_verbosity'));
  },
);
