#!/usr/bin/env node
/**
 * Quick local eval test runner.
 *
 * Writes a temporary experiment file under `experiments/_temp_*.ts` (the
 * `_temp_` prefix is ignored by `agent-eval run-all`), invokes the
 * `agent-eval` CLI against it, and cleans up on exit.
 *
 * Usage:
 *   pnpm test-eval <eval-name> [--agent <agent>] [--model <model>]
 */
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exec } from 'tinyexec';

const { values, positionals } = parseArgs({
  options: {
    agent: { type: 'string', default: 'claude-code' },
    model: { type: 'string', default: 'claude-sonnet-4-6' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log('Usage: pnpm test-eval <eval-name> [--agent <agent>] [--model <model>]');
  process.exit(values.help ? 0 : 1);
}

const evalName = positionals[0]!;
const { agent, model } = values;

const experimentsDir = resolve(process.cwd(), 'experiments');
const tempName = `_temp_${evalName.replace(/[^a-zA-Z0-9_-]/g, '-')}-${process.pid}`;
const tempPath = resolve(experimentsDir, `${tempName}.ts`);

const fileContents = `import type { ExperimentConfig } from '@vercel/agent-eval';
import { baseSetup } from './lib/base-setup.js';

const config: ExperimentConfig = {
  agent: ${JSON.stringify(agent)},
  model: ${JSON.stringify(model)},
  scripts: [],
  runs: 1,
  earlyExit: true,
  timeout: 60 * 15,
  evals: ${JSON.stringify(evalName)},
  setup: baseSetup,
};

export default config;
`;

await writeFile(tempPath, fileContents);

try {
  const result = await exec('pnpm', ['exec', 'agent-eval', tempPath], {
    nodeOptions: { stdio: 'inherit' },
    throwOnError: false,
  });
  process.exitCode = result.exitCode ?? 1;
} finally {
  await rm(tempPath, { force: true });
}
