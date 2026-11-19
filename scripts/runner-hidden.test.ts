import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The pnpm patch makes agent-eval's OpenCode, Claude Code and Codex runners delete themselves before the
// agent starts, so agents can't read the harness. Run a copy of each installed runner with a fake agent CLI
// that records whether the runner file still exists at the moment the CLI starts.
const agents = createRequire(import.meta.url)
  .resolve('@vercel/agent-eval/package.json')
  .replace(/package\.json$/, 'dist/lib/agents/');

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.each([
  ['opencode', 'opencode'],
  ['claude-code', 'claude'],
  ['codex', 'codex'],
])('%s runner patch', (agent, cli) => {
  it('removes the shipped runner before the agent CLI starts', () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-hidden-'));
    const runner = join(dir, '__agent_eval__', 'run.mjs');
    const seen = join(dir, 'seen.txt');
    const argv = join(dir, 'argv.txt');
    mkdirSync(join(dir, '__agent_eval__'));
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(agents, agent, 'run.mjs'), runner);
    const fake = join(dir, 'bin', cli);
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$1" >> '${argv}'\n[ -e '${runner}' ] && echo present >> '${seen}' || echo absent >> '${seen}'\n`,
    );
    chmodSync(fake, 0o755);

    // Codex runs `codex login` first, so every CLI call must see the runner already gone.
    const input = {
      prompt: 'x',
      model: 'm',
      cwd: dir,
      resultPath: join(dir, '__agent_eval__', 'agent-result.json'),
      extra: { cliModel: 'm' },
    };
    spawnSync(process.execPath, [runner, JSON.stringify(input)], {
      cwd: dir,
      // A synthetic OpenRouter key, as on our lanes.
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        OPENROUTER_API_KEY: 'sk-or-SYNTHETIC-0004',
      },
    });

    const calls = readFileSync(seen, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call === 'absent')).toBe(true);
    // On the OpenRouter lane Codex takes the key from the environment: `codex login` would save it in ~/.codex/auth.json.
    if (agent === 'codex') expect(readFileSync(argv, 'utf8').trim().split('\n')).toEqual(['exec']);
  });
});
