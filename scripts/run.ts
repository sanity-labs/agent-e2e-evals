#!/usr/bin/env node
/**
 * Runs eval attempts for one or more experiment configs, a few at a time, and
 * writes everything for this batch under results/<runId>/.
 *
 *   node scripts/run.ts --key-file ~/.openrouter-key --evals sanity-typegen --runs 3 --concurrency 2 --cap 50 experiments/a.ts
 *
 * Why not `agent-eval run`: its CLI starts every attempt at once, needs a
 * Vercel AI Gateway key for its failure classifier, and deletes final non-model
 * failures. This script keeps every final result to label later, limits how
 * many attempts run at once, and checks OpenRouter spend before each starts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createConsoleProgressHandler, loadAllFixtures, loadConfig, runExperiment } from '@vercel/agent-eval';
import pLimit from 'p-limit';
import { scrubSecrets } from '../experiments/lib/redact-secrets.ts';

const { values, positionals } = parseArgs({
  options: {
    'key-file': { type: 'string' },
    evals: { type: 'string' },
    runs: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
    cap: { type: 'string', default: '2' },
  },
  allowPositionals: true,
});

const usage =
  'Usage: node scripts/run.ts --key-file F --evals a,b [--runs N] [--concurrency N] [--cap USD] experiments/x.ts ...';
const positiveInt = (name: string, raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer. ${usage}`);
  return n;
};
const evalNames = values.evals?.split(',').filter(Boolean) ?? [];
if (!values['key-file'] || evalNames.length === 0 || positionals.length === 0) throw new Error(usage);
const runs = positiveInt('runs', values.runs);
const concurrency = positiveInt('concurrency', values.concurrency);
const capUsd = Number(values.cap);
if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error(`--cap must be a non-negative number of USD. ${usage}`);

/** David's line: stop and tell him once this month's OpenRouter spend reaches $750. */
const MONTHLY_STOP_USD = 750;

// Read the key from a mode-0600 file so it never appears in a command line or process list.
const apiKey = readFileSync(values['key-file'], 'utf8').trim();
// The redaction hook and scrubSecrets read known secrets from the environment.
process.env.OPENROUTER_API_KEY = apiKey;

/** Spend on the OpenRouter key: lifetime total and this month, in USD. Throws unless both are numbers. */
async function keyUsage(): Promise<{ total: number; month: number }> {
  const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`OpenRouter key check failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { usage?: unknown; usage_monthly?: unknown } };
  const total = body.data?.usage;
  const month = body.data?.usage_monthly;
  if (typeof total !== 'number' || !Number.isFinite(total) || typeof month !== 'number' || !Number.isFinite(month)) {
    throw new Error('OpenRouter key check returned no usable usage figures');
  }
  return { total, month };
}

interface Attempt {
  experiment: string;
  eval: string;
  run: number;
  /**
   * Every agent invocation behind this attempt. The runner silently re-runs an
   * attempt that fails in under 5s (up to 5 times) and saves only the last one;
   * onRunComplete fires for each, so earlier ones are kept here (already redacted).
   */
  invocations: Array<{ status: string; seconds: number; costUsd?: number; error?: string }>;
  /**
   * Lifetime key usage just before this attempt started. With --concurrency 1 the
   * difference to the next attempt's figure (or openRouterUsageAtEnd) is this
   * attempt's exact OpenRouter cost, retries included.
   */
  openRouterUsageBefore?: number;
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
const start = await keyUsage();
const manifest = {
  runId,
  gitCommit: git('rev-parse', 'HEAD'),
  gitDirty: git('status', '--porcelain') !== '',
  agentEvalVersion: JSON.parse(readFileSync(join(root, 'node_modules/@vercel/agent-eval/package.json'), 'utf8'))
    .version as string,
  evals: evalNames,
  runsPerEval: runs,
  concurrency,
  capUsd,
  monthlyStopUsd: MONTHLY_STOP_USD,
  experiments: [] as Array<{ name: string; agent: string; model: string; timeout: number; sandbox: string }>,
  attempts: [] as Attempt[],
  openRouterUsageAtStart: start.total,
  openRouterUsageAtEnd: null as number | null,
  /** Set when the batch stopped early; no further attempts were started after it. */
  stopped: null as string | null,
  startedAt: new Date().toISOString(),
  endedAt: '',
};
const saveManifest = () => writeFileSync(join(resultsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const errorText = (err: unknown) => scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 2000);

/** Decides whether another attempt may start. Any failure to check spend stops the batch. */
async function spendStop(attempt: Attempt): Promise<string | null> {
  if (manifest.stopped) return manifest.stopped;
  try {
    const now = await keyUsage();
    attempt.openRouterUsageBefore = now.total;
    const spent = now.total - start.total;
    if (now.month >= MONTHLY_STOP_USD) {
      manifest.stopped = `monthly spend $${now.month.toFixed(2)} reached David's $${MONTHLY_STOP_USD} stop: tell him before running more`;
    } else if (spent >= capUsd) {
      manifest.stopped = `batch spend $${spent.toFixed(2)} reached the $${capUsd} cap`;
    }
  } catch (err) {
    manifest.stopped = `spend check failed, so no more attempts were started: ${errorText(err)}`;
  }
  return manifest.stopped;
}

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
        const attempt: Attempt = { experiment, eval: evalName, run, invocations: [] };
        manifest.attempts.push(attempt);
        // A soft stop: attempts already running finish, and their cost shows in the end total.
        const stop = await spendStop(attempt);
        if (stop) {
          attempt.skipped = stop;
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
              onRunComplete: async (context) => {
                const runData = (await config.onRunComplete?.(context)) ?? context.runData;
                const { status, duration, error, usage: tokens } = runData.result;
                attempt.invocations.push({
                  status,
                  seconds: duration,
                  ...(tokens?.costUsd !== undefined ? { costUsd: tokens.costUsd } : {}),
                  ...(error ? { error: errorText(error).slice(0, 500) } : {}),
                });
                return runData;
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
          attempt.error = errorText(err);
        }
        saveManifest();
      });
    }
  }
}

saveManifest();
const limit = pLimit(concurrency);
await Promise.all(jobs.map((job) => limit(job)));

try {
  manifest.openRouterUsageAtEnd = (await keyUsage()).total;
} catch (err) {
  manifest.stopped ??= `final spend check failed: ${errorText(err)}`;
}
manifest.endedAt = new Date().toISOString();
saveManifest();
const spent =
  manifest.openRouterUsageAtEnd === null ? 'unknown' : `$${(manifest.openRouterUsageAtEnd - start.total).toFixed(4)}`;
console.log(
  `\nBatch ${runId}: ${manifest.attempts.length} attempts, OpenRouter spend ${spent}.${manifest.stopped ? ` Stopped: ${manifest.stopped}` : ''}`,
);
console.log(`Results in ${resultsDir}`);
