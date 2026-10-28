#!/usr/bin/env node
/**
 * Runs eval attempts for one or more experiment configs, a few at a time, and
 * writes everything for this batch under results/<runId>/.
 *
 *   node scripts/run.ts --evals sanity-typegen --runs 3 --concurrency 2 --cap 50 experiments/a.ts experiments/b.ts
 *
 * Why not `agent-eval run`: its CLI starts every attempt at once, needs a
 * Vercel AI Gateway key for its failure classifier, and deletes non-model
 * failures. This script keeps every attempt to label later, limits how many
 * run at once, and checks OpenRouter spend before each attempt starts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createConsoleProgressHandler, loadAllFixtures, loadConfig, runExperiment } from '@vercel/agent-eval';
import pLimit from 'p-limit';

const { values, positionals } = parseArgs({
  options: {
    evals: { type: 'string' },
    runs: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '2' },
    cap: { type: 'string', default: '2' },
  },
  allowPositionals: true,
});

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
const evalNames = values.evals?.split(',') ?? [];
if (evalNames.length === 0 || positionals.length === 0) {
  throw new Error(
    'Usage: node scripts/run.ts --evals a,b [--runs N] [--concurrency N] [--cap USD] experiments/x.ts ...',
  );
}
const runs = Number(values.runs);
const capUsd = Number(values.cap);

/** Total spend on the OpenRouter key so far, in USD. */
async function keyUsage(): Promise<number> {
  const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`OpenRouter key check failed: ${res.status}`);
  const { data } = (await res.json()) as { data: { usage: number } };
  return data.usage;
}

interface Attempt {
  experiment: string;
  eval: string;
  run: number;
  /** Sandboxes started. Above 1 means the runner silently retried a fast (<5s) failure. */
  sandboxStarts: number;
  outputDir?: string;
  skipped?: string;
  error?: string;
}

const root = resolve(import.meta.dirname, '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const resultsDir = join(root, 'results', runId);
mkdirSync(resultsDir, { recursive: true });

const { fixtures } = loadAllFixtures(join(root, 'evals'));
const manifest = {
  runId,
  gitCommit: git('rev-parse', 'HEAD'),
  gitDirty: git('status', '--porcelain') !== '',
  agentEvalVersion: JSON.parse(readFileSync(join(root, 'node_modules/@vercel/agent-eval/package.json'), 'utf8'))
    .version as string,
  evals: evalNames,
  runsPerEval: runs,
  capUsd,
  experiments: [] as Array<{ name: string; agent: string; model: unknown; timeout: number; sandbox: string }>,
  attempts: [] as Attempt[],
  openRouterUsageAtStart: await keyUsage(),
  openRouterUsageAtEnd: 0,
  startedAt: new Date().toISOString(),
  endedAt: '',
};
const saveManifest = () => writeFileSync(join(resultsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const jobs: Array<() => Promise<void>> = [];
for (const configPath of positionals) {
  const config = await loadConfig(resolve(configPath));
  const experiment = basename(configPath, '.ts');
  const model = String(config.model);
  manifest.experiments.push({
    name: experiment,
    agent: config.agent,
    model,
    timeout: config.timeout,
    sandbox: config.sandbox,
  });
  for (const evalName of evalNames) {
    const fixture = fixtures.find((f) => f.name === evalName);
    if (!fixture) throw new Error(`Unknown eval: ${evalName}`);
    for (let run = 1; run <= runs; run++) {
      jobs.push(async () => {
        const attempt: Attempt = { experiment, eval: evalName, run, sandboxStarts: 0 };
        manifest.attempts.push(attempt);
        // Soft stop: attempts already running finish and their cost lands in the end total.
        const spent = (await keyUsage()) - manifest.openRouterUsageAtStart;
        if (spent >= capUsd) {
          attempt.skipped = `batch spend $${spent.toFixed(2)} reached cap $${capUsd}`;
          saveManifest();
          return;
        }
        const progress = createConsoleProgressHandler({ experimentName: experiment, model, agent: config.agent });
        try {
          await runExperiment({
            config: {
              ...config,
              model,
              runs: 1,
              evals: evalName,
              // Setup runs once per sandbox, so this counts the runner's hidden retries.
              setup: async (sandbox) => {
                attempt.sandboxStarts++;
                await config.setup?.(sandbox);
              },
            },
            fixtures: [fixture],
            apiKey,
            resultsDir: join(resultsDir, experiment, `${evalName}-run-${run}`),
            experimentName: '.',
            onProgress: (event) => {
              if (event.type === 'experiment:saved') attempt.outputDir = event.outputDir;
              progress(event);
            },
          });
        } catch (err) {
          attempt.error = err instanceof Error ? err.message : String(err);
        }
        saveManifest();
      });
    }
  }
}

saveManifest();
const limit = pLimit(Number(values.concurrency));
await Promise.all(jobs.map((job) => limit(job)));

manifest.openRouterUsageAtEnd = await keyUsage();
manifest.endedAt = new Date().toISOString();
saveManifest();
const spent = manifest.openRouterUsageAtEnd - manifest.openRouterUsageAtStart;
console.log(
  `\nBatch ${runId}: ${manifest.attempts.length} attempts, OpenRouter spend $${spent.toFixed(4)}. Results in ${resultsDir}`,
);
