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
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createConsoleProgressHandler, loadAllFixtures, loadConfig, runExperiment } from '@vercel/agent-eval';
import pLimit from 'p-limit';
import { createPreDeadlineSnapshot } from '../experiments/lib/pre-deadline-snapshot.ts';
import { scrubSecrets } from '../experiments/lib/redact-secrets.ts';
import { SKILLS_REF } from '../experiments/lib/sanity-skills-setup.ts';
import { listStagingProjects, newlyObserved } from './staging-projects.ts';

const { values, positionals } = parseArgs({
  options: {
    'key-file': { type: 'string' },
    evals: { type: 'string' },
    runs: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
    cap: { type: 'string', default: '2' },
    'attempt-stop': { type: 'string' },
  },
  allowPositionals: true,
});

const usage =
  'Usage: node scripts/run.ts --key-file F --evals a,b [--runs N] [--concurrency N] [--cap USD] [--attempt-stop USD] experiments/x.ts ...';
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
/**
 * Optional: stop starting attempts once the key spent more than this between two spend checks. With
 * --concurrency 1 that is the cost of the attempt that just finished (retries included).
 */
const attemptStopUsd = values['attempt-stop'] === undefined ? null : Number(values['attempt-stop']);
if (attemptStopUsd !== null && (!Number.isFinite(attemptStopUsd) || attemptStopUsd <= 0))
  throw new Error(`--attempt-stop must be a positive number of USD. ${usage}`);

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
   * Lifetime key usage just before this attempt started. The difference to the
   * next figure is an observed key-usage delta, not an exact price: other use of
   * the key and provider accounting delay can shift it.
   */
  openRouterUsageBefore?: number;
  outputDir?: string;
  /** Set when the attempt reached the pre-deadline snapshot time: a never-graded diagnostic (pre-deadline-snapshot.ts). */
  timeoutDiagnostic?: { path: string; status: string };
  /** SHA-256 of the prompt this attempt sends (after any experiment editPrompt), so prompt arms can be verified. */
  promptSha256?: string;
  skipped?: string;
  error?: string;
}

const root = resolve(import.meta.dirname, '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const resultsDir = join(root, 'results', runId);
mkdirSync(resultsDir, { recursive: true });

const { fixtures } = loadAllFixtures(join(root, 'evals'));
const errorText = (err: unknown) => scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 2000);

// Scrubbed so a failed first check can't print the key on the way out.
const start = await keyUsage().catch((err: unknown) => {
  throw new Error(errorText(err));
});
// Live tasks get SANITY_AUTH_TOKEN and may create staging projects. List them before and after; never delete.
const sanityToken = process.env.SANITY_AUTH_TOKEN?.trim();
// Every file this batch writes goes through the scrubber; project names are free text.
const writeJson = (name: string, data: unknown) =>
  writeFileSync(join(resultsDir, name), `${scrubSecrets(JSON.stringify(data, null, 2))}\n`);
// Scrubbed so a failed first list can't print the token on the way out.
const projectsBefore = sanityToken
  ? await listStagingProjects(sanityToken).catch((err: unknown) => {
      throw new Error(errorText(err));
    })
  : null;
if (projectsBefore) writeJson('staging-projects-before.json', projectsBefore);
const manifest = {
  runId,
  gitCommit: git('rev-parse', 'HEAD'),
  gitDirty: git('status', '--porcelain') !== '',
  /** agent-toolkit ref the skills cells install; unused by no-skills cells. */
  skillsRef: SKILLS_REF,
  agentEvalVersion: JSON.parse(readFileSync(join(root, 'node_modules/@vercel/agent-eval/package.json'), 'utf8'))
    .version as string,
  evals: evalNames,
  runsPerEval: runs,
  concurrency,
  capUsd,
  attemptStopUsd,
  monthlyStopUsd: MONTHLY_STOP_USD,
  experiments: [] as Array<{ name: string; agent: string; model: string; timeout: number; sandbox: string }>,
  attempts: [] as Attempt[],
  openRouterUsageAtStart: start.total,
  openRouterUsageAtEnd: null as number | null,
  /**
   * Staging projects first seen during the batch (raw lists are in staging-projects-*.json).
   * Not proof this batch created them: the token is shared. Null when no Sanity token was given.
   */
  stagingProjectsNewlyObserved: null as Array<{ id: string; displayName?: string; createdAt?: string }> | null,
  stagingProjectsError: null as string | null,
  /** Set when the batch stopped early; no further attempts were started after it. */
  stopped: null as string | null,
  startedAt: new Date().toISOString(),
  endedAt: '',
};
const saveManifest = () => writeJson('manifest.json', manifest);
/** Key usage at the previous spend check, for --attempt-stop. */
let previousUsage = start.total;
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
    } else if (attemptStopUsd !== null && now.total - previousUsage > attemptStopUsd) {
      manifest.stopped = `$${(now.total - previousUsage).toFixed(2)} was spent since the previous spend check, over the $${attemptStopUsd} per-attempt stop: report before running more`;
    }
    previousUsage = now.total;
  } catch (err) {
    manifest.stopped = `spend check failed, so no more attempts were started: ${errorText(err)}`;
  }
  return manifest.stopped;
}

// The starter's build installs the app itself, so an agent edit to either entrypoint must not
// reach the grader. Its app changes are saved for manual review (env files dropped by redactSecrets).
const STARTER = { protectedPaths: ['package.json', 'build.mjs'], copyFiles: 'changed' as const };
// The Function and migration tasks save their changed files for failure review. Deleted
// files are not saved: changed-file evidence, not a replayable final tree.
const FUNCTION = { copyFiles: 'changed' as const };
// The migration grader typechecks with the shipped tsconfig.json, so the agent must not change it.
const MIGRATION = { ...FUNCTION, protectedPaths: ['tsconfig.json'] };
// The upgrade task changes package.json on purpose, so only tsconfig.json is protected (the grader typechecks with it).
const UPGRADE = MIGRATION;
// The schema task needs no new dependencies. Protecting them stops a "file:" dependency from replacing the grader's
// own packages in the verifier's fresh install; its grader also typechecks with the shipped tsconfig.
const SCHEMA = { ...FUNCTION, protectedPaths: ['tsconfig.json', 'package.json', 'npm-shrinkwrap.json', '.npmrc'] };
// The Astro task builds against the shipped local content API, so the agent must not change it, its scripts or dependencies.
const ASTRO = { ...FUNCTION, protectedPaths: [...SCHEMA.protectedPaths, 'scripts/sample-api.mjs'] };
const WEBHOOK = {
  ...FUNCTION,
  protectedPaths: [...SCHEMA.protectedPaths, 'scripts/sample-api.mjs', 'app/api/sample-witness/route.ts'],
};
// The App SDK read task grades only src/PostList.tsx: every other change (configs, App.tsx, dependencies) is kept out
// of grading and reported as tampering. A root config file such as postcss.config.cjs is loaded by the grader's own vitest.
const APPSDK = { ...FUNCTION, protectedPaths: ['!src/PostList.tsx'] };
// The GROQ cursor task grades only src/pagination.ts the same way; every other change is reported as tampering.
const GROQCURSOR = { ...FUNCTION, protectedPaths: ['!src/pagination.ts'] };
// The Portable Text task grades only the Studio config and schema types; every other change is reported as tampering.
const PORTABLETEXT = { ...FUNCTION, protectedPaths: ['!{sanity.config.ts,schemaTypes/**}'] };

const loaded: Array<{ config: Awaited<ReturnType<typeof loadConfig>>; experiment: string; model: string }> = [];
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
  loaded.push({ config, experiment, model });
}
const fixtureFor = (evalName: string) => {
  const fixture = fixtures.find((f) => f.name === evalName);
  if (!fixture) throw new Error(`Unknown eval: ${evalName}`);
  return fixture;
};
for (const evalName of evalNames) fixtureFor(evalName);

// Queue attempts round by round, reversing experiment order on even rounds, so paired arms alternate (A B B A ...).
const jobs: Array<() => Promise<void>> = [];
for (let run = 1; run <= runs; run++) {
  for (const { config, experiment, model } of run % 2 === 1 ? loaded : [...loaded].reverse()) {
    for (const evalName of evalNames) {
      const fixture = fixtureFor(evalName);
      jobs.push(async () => {
        const prompt = config.editPrompt ? config.editPrompt(fixture.prompt) : fixture.prompt;
        const promptSha256 = createHash('sha256').update(prompt).digest('hex');
        const attempt: Attempt = { experiment, eval: evalName, run, promptSha256, invocations: [] };
        manifest.attempts.push(attempt);
        saveManifest(); // on disk before any model call, so a stopped machine can't hide a started attempt
        // A soft stop: attempts already running finish, and their cost shows in the end total.
        const stop = await spendStop(attempt);
        if (stop) {
          attempt.skipped = stop;
          saveManifest();
          return;
        }
        const progress = createConsoleProgressHandler({ experimentName: experiment, model, agent: config.agent });
        const attemptDir = join(resultsDir, experiment, `${evalName}-run-${run}`);
        // Taken now, before the native timer starts, so the snapshot always comes before the native limit.
        const snapshot = createPreDeadlineSnapshot({ deadlineAt: Date.now() + config.timeout * 1000 });
        try {
          await runExperiment({
            config: {
              ...config,
              model,
              runs: 1,
              evals: evalName,
              ...(evalName === 'sanity-nextjs-starter' ? STARTER : {}),
              ...(evalName === 'sanity-blueprints'
                ? FUNCTION
                : evalName === 'sanity-migration'
                  ? MIGRATION
                  : evalName === 'sanity-studio-upgrade'
                    ? UPGRADE
                    : evalName === 'sanity-schema'
                      ? SCHEMA
                      : evalName === 'sanity-astro'
                        ? ASTRO
                        : evalName === 'sanity-webhook'
                          ? WEBHOOK
                          : evalName === 'sanity-appsdk-read'
                            ? APPSDK
                            : evalName === 'sanity-groq-cursor'
                              ? GROQCURSOR
                              : evalName === 'sanity-portable-text'
                                ? PORTABLETEXT
                                : {}),
              setup: snapshot.wrapSetup(config.setup),
              onRunComplete: async (context) => {
                snapshot.invocationEnded();
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
            resultsDir: attemptDir,
            experimentName: '.',
            onProgress: (event) => {
              if (event.type === 'experiment:saved') attempt.outputDir = relative(resultsDir, event.outputDir);
              progress(event);
            },
          });
        } catch (err) {
          attempt.error = errorText(err);
        }
        const diagnostic = snapshot.finish();
        if (diagnostic) {
          const path = join(attemptDir, 'timeout-diagnostic.json');
          mkdirSync(attemptDir, { recursive: true });
          writeFileSync(path, `${scrubSecrets(JSON.stringify(diagnostic, null, 2))}\n`);
          attempt.timeoutDiagnostic = { path: relative(resultsDir, path), status: diagnostic.status };
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
if (sanityToken && projectsBefore) {
  try {
    const after = await listStagingProjects(sanityToken);
    writeJson('staging-projects-after.json', after);
    manifest.stagingProjectsNewlyObserved = newlyObserved(projectsBefore, after);
  } catch (err) {
    manifest.stagingProjectsError = errorText(err);
  }
}
manifest.endedAt = new Date().toISOString();
saveManifest();
const spent =
  manifest.openRouterUsageAtEnd === null ? 'unknown' : `$${(manifest.openRouterUsageAtEnd - start.total).toFixed(4)}`;
console.log(
  `\nBatch ${runId}: ${manifest.attempts.length} attempts, OpenRouter spend ${spent}.${manifest.stopped ? ` Stopped: ${manifest.stopped}` : ''}`,
);
if (manifest.stagingProjectsNewlyObserved?.length) {
  console.log(
    `Staging projects first seen during this batch (not proof this batch created them; reconcile by hand): ${manifest.stagingProjectsNewlyObserved.map((p) => p.id).join(', ')}`,
  );
}
console.log(`Results in ${resultsDir}`);
