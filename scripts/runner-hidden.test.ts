import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The pnpm patch makes agent-eval's OpenCode runner delete itself before the agent starts, so agents
// can't read the harness. Run a copy of the installed runner with a fake `opencode` that records
// whether the runner file still exists at the moment the agent CLI starts.
const installedRunner = createRequire(import.meta.url)
  .resolve('@vercel/agent-eval/package.json')
  .replace(/package\.json$/, 'dist/lib/agents/opencode/run.mjs');

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('OpenCode runner patch', () => {
  it('removes the shipped runner before the agent CLI starts', () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-hidden-'));
    const runner = join(dir, '__agent_eval__', 'run.mjs');
    const seen = join(dir, 'seen.txt');
    mkdirSync(join(dir, '__agent_eval__'));
    mkdirSync(join(dir, 'bin'));
    copyFileSync(installedRunner, runner);
    const fake = join(dir, 'bin', 'opencode');
    writeFileSync(fake, `#!/bin/sh\n[ -e '${runner}' ] && echo present >> '${seen}' || echo absent >> '${seen}'\n`);
    chmodSync(fake, 0o755);

    const input = { prompt: 'x', cwd: dir, resultPath: join(dir, '__agent_eval__', 'agent-result.json') };
    spawnSync(process.execPath, [runner, JSON.stringify(input)], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    });

    expect(readFileSync(seen, 'utf8').trim().split('\n')[0]).toBe('absent');
  });
});
