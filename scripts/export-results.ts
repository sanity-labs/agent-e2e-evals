#!/usr/bin/env node
/**
 * Summarise one batch written by scripts/run.ts.
 *
 *   node scripts/export-results.ts results/<runId> [report.json]
 *
 * Writes the report (default results/<runId>/report.json; pass a path to leave the run folder
 * untouched) and prints one descriptive row per model × task: no ranking or significance tests. Every executed test in
 * an EVAL.ts is a core check, so a saved status of "passed" means the configured
 * scripts and every core check passed.
 *
 * Infrastructure failures are never inferred. To mark one, write the evidence in
 * results/<runId>/labels.json: { "<experiment>/<eval>/<run>": { "outcome": "infra", "evidence": "..." } }
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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

/**
 * Evals whose graders are structural diagnostics only: a green result shows the SDK pieces exist,
 * not that the task works, so the outcome stays unknown until a person labels it
 * (research/presentation-live-contract.md).
 */
const LABEL_ONLY_EVALS = new Set(['sanity-presentation', 'sanity-live-content', 'sanity-nextjs-starter']);

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
const sumOf = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
function medianOf(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const known = (xs: Array<number | null>) => xs.filter((x): x is number => x !== null);

/** A skill file or the skill tool, as in the cross-check audit: a tool call that opens a skill. */
const SKILL_READ = /\.agents\/skills\/|skills\/[a-z0-9-]+\/(SKILL\.md|references\/)/;

/**
 * What the saved transcript shows: tokens summed over OpenCode's step_finish events (the result's
 * usage is null for OpenCode; OpenCode's total includes cache reads) and whether any tool call used a skill. Null when there is no transcript.
 */
function readTranscript(runDir: string) {
  const path = join(runDir, 'transcript-raw.jsonl');
  if (!existsSync(path)) return { tokens: null, skillUsed: null };
  let tokens: number | null = null;
  let skillUsed = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { type?: string; part?: { tool?: string; tokens?: { total?: number }; state?: { input?: unknown } } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'step_finish' && typeof e.part?.tokens?.total === 'number')
      tokens = (tokens ?? 0) + e.part.tokens.total;
    if (
      e.type === 'tool_use' &&
      (e.part?.tool === 'skill' || SKILL_READ.test(JSON.stringify(e.part?.state?.input ?? '')))
    )
      skillUsed = true;
  }
  return { tokens, skillUsed };
}

/** Files the agent changed, counted only from a saved workspace diff (copyFiles); null otherwise. */
function countFiles(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (t, d) => t + (d.isDirectory() ? countFiles(join(dir, d.name)) : 1),
    0,
  );
}

/**
 * Attempt folders are stored relative to the batch folder, so a copied batch still exports.
 * Older manifests stored absolute paths on the machine that ran them; for those, keep the part
 * after the batch's own runId folder.
 */
function attemptDir(batchDir: string, runId: string, outputDir: string) {
  if (!isAbsolute(outputDir)) return resolve(batchDir, outputDir);
  const i = outputDir.indexOf(`/${runId}/`);
  return i === -1 ? outputDir : resolve(batchDir, outputDir.slice(i + runId.length + 2));
}

export function gradeAttempt(attempt: Attempt, label?: Label, batchDir = '.', runId = '') {
  const runDir = attempt.outputDir
    ? join(attemptDir(batchDir, runId, attempt.outputDir), attempt.eval, 'run-1')
    : undefined;
  const result = runDir
    ? readJson<{
        status: string;
        error?: string;
        usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
      }>(join(runDir, 'result.json'))
    : undefined;
  const testsRan = !!runDir && existsSync(join(runDir, 'outputs/eval.txt'));
  const transcript = runDir ? readTranscript(runDir) : { tokens: null, skillUsed: null };
  const projectDir = runDir && join(runDir, 'project');
  const outcome = (o: Outcome, reason: string) => ({
    experiment: attempt.experiment,
    eval: attempt.eval,
    run: attempt.run,
    outcome: o,
    reason,
    invocations: attempt.invocations.length,
    seconds: attempt.invocations.reduce((t, i) => t + i.seconds, 0),
    tokens: totalTokens(result?.usage) ?? transcript.tokens,
    openCodeEstUsd: attempt.invocations.reduce((t, i) => t + (i.costUsd ?? 0), 0),
    skillUsed: transcript.skillUsed,
    filesChanged: projectDir && existsSync(projectDir) ? countFiles(projectDir) : null,
  });

  if (label) return outcome(label.outcome, `labelled: ${label.evidence}`);
  // The runner silently re-ran a fast failure, so pass@1 would count a second try; a person decides.
  if (attempt.invocations.length > 1)
    return outcome('unknown', `retried ${attempt.invocations.length - 1}x by the runner; label it in labels.json`);
  if (LABEL_ONLY_EVALS.has(attempt.eval))
    return outcome('unknown', `saved validation status ${result?.status ?? 'missing'}; outcome needs a manual label`);
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

export function exportRun(runDir: string, reportPath = join(runDir, 'report.json')) {
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
  const attempts = ran.map((a) =>
    gradeAttempt(a, labels[`${a.experiment}/${a.eval}/${a.run}`], runDir, manifest.runId),
  );
  const scheduled = Map.groupBy(manifest.attempts, (a) => `${a.experiment} × ${a.eval}`);
  const rows = [...Map.groupBy(attempts, (a) => `${a.experiment} × ${a.eval}`)].map(([group, list]) => {
    const count = (o: Outcome) => list.filter((a) => a.outcome === o).length;
    const pass = count('pass');
    const graded = pass + count('agent');
    const mean = (k: 'seconds' | 'openCodeEstUsd') => list.reduce((t, a) => t + a[k], 0) / list.length;
    const stat = (xs: number[]) => ({ median: medianOf(xs), total: xs.length ? sumOf(xs) : null, known: xs.length });
    const experiment = list[0]!.experiment;
    return {
      group,
      scheduled: scheduled.get(group)?.length ?? list.length,
      completed: list.length,
      pass,
      graded,
      wilson95: wilson(pass, graded),
      agent: count('agent'),
      infra: count('infra'),
      // Kept out of the pass@1 denominator; each with the evidence its label gives.
      infraFailures: list.filter((a) => a.outcome === 'infra').map((a) => ({ run: a.run, reason: a.reason })),
      unknown: count('unknown'),
      meanSeconds: mean('seconds'),
      meanOpenCodeEstUsd: mean('openCodeEstUsd'),
      meanTokens: meanOf(known(list.map((a) => a.tokens))),
      costUsd: stat(list.map((a) => a.openCodeEstUsd)),
      tokens: stat(known(list.map((a) => a.tokens))),
      seconds: stat(list.map((a) => a.seconds)),
      // Experiments named *-skills install the Sanity skills (experiments/lib/openrouter.ts).
      skillsInstalled: experiment.endsWith('-skills'),
      skillUsed: list.filter((a) => a.skillUsed).length,
      filesChanged: stat(known(list.map((a) => a.filesChanged))),
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
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.main) {
  const [runDir, reportPath] = process.argv.slice(2);
  if (!runDir) throw new Error('Usage: node scripts/export-results.ts results/<runId> [report.json]');
  const report = exportRun(resolve(runDir), reportPath && resolve(reportPath));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const fmt = (x: number | null, digits = 0) => (x === null ? 'n/a' : x.toFixed(digits));
  console.table(
    report.rows.map((r) => ({
      'model × task': r.group,
      'scheduled / completed': `${r.scheduled} / ${r.completed}`,
      'pass@1 (95% CI)': r.graded ? `${r.pass}/${r.graded} (${pct(r.wilson95[0])}–${pct(r.wilson95[1])})` : 'n/a',
      agent: r.agent,
      infra: r.infra,
      unknown: r.unknown,
      '$ median / total': `${fmt(r.costUsd.median, 3)} / ${fmt(r.costUsd.total, 2)}`,
      'tokens incl. cache median / total': `${fmt(r.tokens.median)} / ${fmt(r.tokens.total)}`,
      's median / total': `${fmt(r.seconds.median)} / ${fmt(r.seconds.total)}`,
      'skill used / installed': r.skillsInstalled ? `${r.skillUsed}/${r.completed}` : `${r.skillUsed} (not installed)`,
      'files changed median': fmt(r.filesChanged.median),
      'silently retried': r.retriedAttempts,
    })),
  );
  for (const r of report.rows)
    for (const f of r.infraFailures) console.log(`infra: ${r.group} run ${f.run}: ${f.reason}`);
  const spend = report.openRouterUsageDeltaUsd === null ? 'unknown' : `$${report.openRouterUsageDeltaUsd.toFixed(2)}`;
  console.log(
    `OpenRouter key usage delta (observed) ${spend}. $ per attempt is OpenCode's estimate. Skipped ${report.skipped}${report.stopped ? ` (stopped: ${report.stopped})` : ''}. ${report.valid ? 'Valid.' : 'NOT VALID: unknown outcomes remain.'}`,
  );
}
