#!/usr/bin/env node
/**
 * Summarise one batch written by scripts/run.ts.
 *
 *   node scripts/export-results.ts results/<runId>
 *
 * Writes results/<runId>/report.json and prints a table. Every executed test in
 * an EVAL.ts is a core check, so a saved status of "passed" means the configured
 * scripts and every core check passed.
 *
 * Infrastructure failures are never inferred. To mark one, write the evidence in
 * results/<runId>/labels.json: { "<experiment>/<eval>/<run>": { "outcome": "infra", "evidence": "..." } }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Outcome = 'pass' | 'agent' | 'infra' | 'unknown';

interface Attempt {
  experiment: string;
  eval: string;
  run: number;
  invocations: Array<{ status: string; seconds: number; costUsd?: number; error?: string }>;
  outputDir?: string;
  skipped?: string;
  error?: string;
}

interface Label {
  outcome: Outcome;
  evidence: string;
}

const readJson = <T>(p: string): T | undefined =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined;

/** The CLI's own total, else input + output when both are reported; null when neither is known. */
function totalTokens(usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }) {
  if (usage?.totalTokens !== undefined) return usage.totalTokens;
  if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined)
    return usage.inputTokens + usage.outputTokens;
  return null;
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);

export function gradeAttempt(attempt: Attempt, label?: Label) {
  const runDir = attempt.outputDir ? join(attempt.outputDir, attempt.eval, 'run-1') : undefined;
  const result = runDir
    ? readJson<{
        status: string;
        error?: string;
        usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
      }>(join(runDir, 'result.json'))
    : undefined;
  const testsRan = !!runDir && existsSync(join(runDir, 'outputs/eval.txt'));
  const outcome = (o: Outcome, reason: string) => ({
    experiment: attempt.experiment,
    eval: attempt.eval,
    run: attempt.run,
    outcome: o,
    reason,
    invocations: attempt.invocations.length,
    seconds: attempt.invocations.reduce((t, i) => t + i.seconds, 0),
    tokens: totalTokens(result?.usage),
    openCodeEstUsd: attempt.invocations.reduce((t, i) => t + (i.costUsd ?? 0), 0),
  });

  if (label) return outcome(label.outcome, `labelled: ${label.evidence}`);
  // The runner silently re-ran a fast failure, so pass@1 would count a second try; a person decides.
  if (attempt.invocations.length > 1)
    return outcome('unknown', `retried ${attempt.invocations.length - 1}x by the runner; label it in labels.json`);
  if (!result) return outcome('unknown', attempt.error ? `runner error: ${attempt.error}` : 'no result.json');
  if (result.status === 'passed') return outcome('pass', 'typecheck and core checks passed');
  if (result.error?.includes('timed out')) return outcome('agent', result.error);
  if (testsRan) return outcome('agent', 'typecheck or a core check failed; see outputs/');
  return outcome('unknown', result.error ? `no test output: ${result.error}` : 'no test output');
}

/** Wilson score interval, 95%. */
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function exportRun(runDir: string) {
  const manifest = readJson<{
    runId: string;
    gitCommit: string;
    gitDirty: boolean;
    agentEvalVersion: string;
    experiments: unknown[];
    attempts: Attempt[];
    stopped: string | null;
    openRouterUsageAtStart: number | null;
    openRouterUsageAtEnd: number | null;
  }>(join(runDir, 'manifest.json'));
  if (!manifest) throw new Error(`No manifest.json in ${runDir}`);
  const labels = readJson<Record<string, Label>>(join(runDir, 'labels.json')) ?? {};

  const ran = manifest.attempts.filter((a) => !a.skipped);
  const attempts = ran.map((a) => gradeAttempt(a, labels[`${a.experiment}/${a.eval}/${a.run}`]));
  const rows = [...Map.groupBy(attempts, (a) => `${a.experiment} × ${a.eval}`)].map(([group, list]) => {
    const count = (o: Outcome) => list.filter((a) => a.outcome === o).length;
    const pass = count('pass');
    const graded = pass + count('agent');
    const mean = (k: 'seconds' | 'openCodeEstUsd') => list.reduce((t, a) => t + a[k], 0) / list.length;
    return {
      group,
      pass,
      graded,
      wilson95: wilson(pass, graded),
      agent: count('agent'),
      infra: count('infra'),
      unknown: count('unknown'),
      meanSeconds: mean('seconds'),
      meanOpenCodeEstUsd: mean('openCodeEstUsd'),
      meanTokens: meanOf(list.flatMap((a) => (a.tokens === null ? [] : [a.tokens]))),
      retriedAttempts: list.filter((a) => a.invocations > 1).length,
    };
  });

  const report = {
    runId: manifest.runId,
    gitCommit: manifest.gitCommit,
    gitDirty: manifest.gitDirty,
    agentEvalVersion: manifest.agentEvalVersion,
    experiments: manifest.experiments,
    stopped: manifest.stopped,
    skipped: manifest.attempts.length - ran.length,
    // Valid only when every attempt that ran has a known outcome, as in next-evals' release gate.
    valid: attempts.every((a) => a.outcome !== 'unknown'),
    openRouterUsageDeltaUsd:
      manifest.openRouterUsageAtEnd === null || manifest.openRouterUsageAtStart === null
        ? null
        : manifest.openRouterUsageAtEnd - manifest.openRouterUsageAtStart,
    rows,
    attempts,
  };
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.main) {
  const runDir = process.argv[2];
  if (!runDir) throw new Error('Usage: node scripts/export-results.ts results/<runId>');
  const report = exportRun(resolve(runDir));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.table(
    report.rows.map((r) => ({
      'experiment × eval': r.group,
      'pass@1 (95% CI)': r.graded ? `${r.pass}/${r.graded} (${pct(r.wilson95[0])}–${pct(r.wilson95[1])})` : 'n/a',
      agent: r.agent,
      infra: r.infra,
      unknown: r.unknown,
      's/attempt': Math.round(r.meanSeconds),
      'tokens/attempt': r.meanTokens === null ? 'n/a' : Math.round(r.meanTokens),
      'OpenCode est. $/attempt': r.meanOpenCodeEstUsd.toFixed(3),
      'silently retried': r.retriedAttempts,
    })),
  );
  const spend = report.openRouterUsageDeltaUsd === null ? 'unknown' : `$${report.openRouterUsageDeltaUsd.toFixed(2)}`;
  console.log(
    `OpenRouter key usage delta (observed) ${spend}. Skipped ${report.skipped}${report.stopped ? ` (stopped: ${report.stopped})` : ''}. ${report.valid ? 'Valid.' : 'NOT VALID: unknown outcomes remain.'}`,
  );
}
