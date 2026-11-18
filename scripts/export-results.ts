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
import { stripVTControlCharacters } from 'node:util';

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
 * Evals whose outcome stays unknown until a person labels it: presentation and live content have
 * structural diagnostics only; the starter build and the blueprints runtime observations are diagnostics a
 * reviewer reads.
 */
const LABEL_ONLY_EVALS = new Set([
  'sanity-presentation',
  'sanity-live-content',
  'sanity-nextjs-starter',
  'sanity-blueprints',
]);

const readJson = <Value>(filePath: string): Value | undefined =>
  existsSync(filePath) ? (JSON.parse(readFileSync(filePath, 'utf8')) as Value) : undefined;

/** The CLI's own total, else input + output when both are reported; null when neither is known. */
function totalTokens(usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }) {
  if (usage?.totalTokens !== undefined) return usage.totalTokens;
  if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined)
    return usage.inputTokens + usage.outputTokens;
  return null;
}

const meanOf = (values: number[]) =>
  values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const sumOf = (values: number[]) => values.reduce((total, value) => total + value, 0);
function medianOf(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const known = (values: Array<number | null>) => values.filter((value): value is number => value !== null);

/** A skill file or the skill tool, as in the cross-check audit: a tool call that opens a skill. */
const SKILL_READ = /\.agents\/skills\/|skills\/[a-z0-9-]+\/(SKILL\.md|references\/)/;

/**
 * What the saved transcript shows: tokens summed over OpenCode's step_finish events (the result's
 * usage is null for OpenCode; OpenCode's total includes cache reads). After a runner retry only the
 * final invocation's transcript is saved, so tokens cover that invocation only. Also reports whether any tool call used a skill. Null when there is no transcript.
 */
function readTranscript(runDir: string) {
  const path = join(runDir, 'transcript-raw.jsonl');
  if (!existsSync(path)) return { tokens: null, skillUsed: null };
  let tokens: number | null = null;
  let skillUsed = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; part?: { tool?: string; tokens?: { total?: number }; state?: { input?: unknown } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'step_finish' && typeof event.part?.tokens?.total === 'number')
      tokens = (tokens ?? 0) + event.part.tokens.total;
    if (
      event.type === 'tool_use' &&
      (event.part?.tool === 'skill' || SKILL_READ.test(JSON.stringify(event.part?.state?.input ?? '')))
    )
      skillUsed = true;
  }
  return { tokens, skillUsed };
}

/**
 * Files retained in a saved project/ folder (copyFiles), after redactSecrets filtering; null when none
 * was saved. A count of captured files, not of every file the agent changed.
 */
function countFiles(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1),
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
  const runIdIndex = outputDir.indexOf(`/${runId}/`);
  return runIdIndex === -1 ? outputDir : resolve(batchDir, outputDir.slice(runIdIndex + runId.length + 2));
}

const GRADER_UNKNOWN = /^\s*(→|AssertionError:)\s*UNKNOWN \(/m;

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
  // run.ts saves an attempt when it starts; it has a runner result only once an invocation is recorded.
  const finished = attempt.invocations.length > 0;
  const outcome = (outcomeValue: Outcome, reason: string) => ({
    experiment: attempt.experiment,
    eval: attempt.eval,
    run: attempt.run,
    outcome: outcomeValue,
    reason,
    invocations: attempt.invocations.length,
    // Null, not zero, for an attempt saved at start that never got a runner result.
    seconds: finished ? attempt.invocations.reduce((total, invocation) => total + invocation.seconds, 0) : null,
    tokens: totalTokens(result?.usage) ?? transcript.tokens,
    // OpenCode omits cost when a step has no price; a missing or partial sum stays unknown, a reported 0 stays 0.
    openCodeEstUsd:
      finished && attempt.invocations.every((invocation) => invocation.costUsd !== undefined)
        ? attempt.invocations.reduce((total, invocation) => total + invocation.costUsd!, 0)
        : null,
    skillUsed: transcript.skillUsed,
    filesCaptured: projectDir && existsSync(projectDir) ? countFiles(projectDir) : null,
  });

  if (label) return outcome(label.outcome, `labelled: ${label.evidence}`);
  if (!finished) return outcome('unknown', 'started but no runner result saved (interrupted or still running)');
  // The runner silently re-ran a fast failure, so pass@1 would count a second try; a person decides.
  if (attempt.invocations.length > 1)
    return outcome('unknown', `retried ${attempt.invocations.length - 1}x by the runner; label it in labels.json`);
  if (LABEL_ONLY_EVALS.has(attempt.eval))
    return outcome('unknown', `saved validation status ${result?.status ?? 'missing'}; outcome needs a manual label`);
  if (!result) return outcome('unknown', attempt.error ? `runner error: ${attempt.error}` : 'no result.json');
  if (result.status === 'passed') return outcome('pass', 'typecheck and core checks passed');
  if (result.error?.includes('timed out')) return outcome('agent', result.error);
  // A grader may declare it could not observe the attempt ("UNKNOWN (" in an assertion message, not a code frame).
  if (testsRan && GRADER_UNKNOWN.test(stripVTControlCharacters(readFileSync(join(runDir, 'outputs/eval.txt'), 'utf8'))))
    return outcome('unknown', 'the grader reported it could not observe this attempt; see outputs/eval.txt');
  if (testsRan) return outcome('agent', 'typecheck or a core check failed; see outputs/');
  return outcome('unknown', result.error ? `no test output: ${result.error}` : 'no test output');
}

/** Wilson score interval, 95%. */
export function wilson(successes: number, sampleSize: number): [number, number] {
  if (sampleSize === 0) return [0, 1];
  const zScore = 1.96;
  const proportion = successes / sampleSize;
  const centre = (proportion + (zScore * zScore) / (2 * sampleSize)) / (1 + (zScore * zScore) / sampleSize);
  const half =
    (zScore / (1 + (zScore * zScore) / sampleSize)) *
    Math.sqrt((proportion * (1 - proportion)) / sampleSize + (zScore * zScore) / (4 * sampleSize * sampleSize));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function exportRun(runDir: string, reportPath = join(runDir, 'report.json')) {
  const manifest = readJson<{
    runId: string;
    gitCommit: string;
    gitDirty: boolean;
    agentEvalVersion: string;
    experiments: Array<{ name: string }>;
    evals?: string[];
    runsPerEval?: number;
    endedAt?: string;
    attempts: Attempt[];
    stopped: string | null;
    openRouterUsageAtStart: number | null;
    openRouterUsageAtEnd: number | null;
  }>(join(runDir, 'manifest.json'));
  if (!manifest) throw new Error(`No manifest.json in ${runDir}`);
  const labels = readJson<Record<string, Label>>(join(runDir, 'labels.json')) ?? {};

  const ran = manifest.attempts.filter((attempt) => !attempt.skipped);
  const attempts = ran.map((attempt) =>
    gradeAttempt(attempt, labels[`${attempt.experiment}/${attempt.eval}/${attempt.run}`], runDir, manifest.runId),
  );
  // Planned comes from the batch's own settings: a manifest written by an older runner, or cut off
  // before an attempt started, can be missing attempts that were still planned.
  const planned = new Map<string, number>();
  for (const experiment of manifest.experiments ?? [])
    for (const evalName of manifest.evals ?? [])
      planned.set(`${experiment.name} × ${evalName}`, manifest.runsPerEval ?? 0);
  const saved = Map.groupBy(manifest.attempts, (attempt) => `${attempt.experiment} × ${attempt.eval}`);
  const byGroup = Map.groupBy(attempts, (attempt) => `${attempt.experiment} × ${attempt.eval}`);
  const groups = [...new Set([...planned.keys(), ...saved.keys()])];
  const rows = groups.map((group) => {
    const list = byGroup.get(group) ?? [];
    const count = (outcome: Outcome) => list.filter((attempt) => attempt.outcome === outcome).length;
    const pass = count('pass');
    const graded = pass + count('agent');
    const stat = (values: number[]) => ({
      median: medianOf(values),
      total: values.length ? sumOf(values) : null,
      known: values.length,
    });
    const experiment = group.slice(0, group.indexOf(' × '));
    return {
      group,
      planned: planned.get(group) ?? null,
      saved: saved.get(group)?.length ?? 0,
      completed: list.filter((attempt) => attempt.invocations > 0).length,
      pass,
      graded,
      wilson95: wilson(pass, graded),
      agent: count('agent'),
      infra: count('infra'),
      // Kept out of the pass@1 denominator; each with the evidence its label gives.
      infraFailures: list
        .filter((attempt) => attempt.outcome === 'infra')
        .map((attempt) => ({ run: attempt.run, reason: attempt.reason })),
      unknown: count('unknown'),
      meanSeconds: meanOf(known(list.map((attempt) => attempt.seconds))),
      meanOpenCodeEstUsd: meanOf(known(list.map((attempt) => attempt.openCodeEstUsd))),
      meanTokens: meanOf(known(list.map((attempt) => attempt.tokens))),
      costUsd: stat(known(list.map((attempt) => attempt.openCodeEstUsd))),
      tokens: stat(known(list.map((attempt) => attempt.tokens))),
      seconds: stat(known(list.map((attempt) => attempt.seconds))),
      // Experiments named *-skills install the Sanity skills (experiments/lib/openrouter.ts).
      skillsInstalled: experiment.endsWith('-skills'),
      skillUsed: list.filter((attempt) => attempt.skillUsed).length,
      filesCaptured: stat(known(list.map((attempt) => attempt.filesCaptured))),
      retriedAttempts: list.filter((attempt) => attempt.invocations > 1).length,
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
    // A batch with no endedAt stopped before finishing; planned attempts may be missing.
    incomplete: !manifest.endedAt,
    // Valid only when the batch finished and every attempt that ran has a known outcome, as in next-evals' release gate.
    valid: !!manifest.endedAt && attempts.every((attempt) => attempt.outcome !== 'unknown'),
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
  const percentage = (value: number) => `${Math.round(value * 100)}%`;
  const format = (value: number | null, digits = 0) => (value === null ? 'n/a' : value.toFixed(digits));
  console.table(
    report.rows.map((row) => ({
      'model × task': row.group,
      'planned / saved / completed': `${row.planned ?? '?'} / ${row.saved} / ${row.completed}`,
      'pass@1 (95% CI)': row.graded
        ? `${row.pass}/${row.graded} (${percentage(row.wilson95[0])}–${percentage(row.wilson95[1])})`
        : 'n/a',
      agent: row.agent,
      infra: row.infra,
      unknown: row.unknown,
      '$ median / total': `${format(row.costUsd.median, 3)} / ${format(row.costUsd.total, 2)}`,
      'final-transcript tokens incl. cache median / total': `${format(row.tokens.median)} / ${format(row.tokens.total)}`,
      's median / total': `${format(row.seconds.median)} / ${format(row.seconds.total)}`,
      'skill used / installed': row.skillsInstalled
        ? `${row.skillUsed}/${row.completed}`
        : `${row.skillUsed} (not installed)`,
      'captured files median': format(row.filesCaptured.median),
      'silently retried': row.retriedAttempts,
    })),
  );
  for (const row of report.rows)
    for (const failure of row.infraFailures) console.log(`infra: ${row.group} run ${failure.run}: ${failure.reason}`);
  const spend = report.openRouterUsageDeltaUsd === null ? 'unknown' : `$${report.openRouterUsageDeltaUsd.toFixed(2)}`;
  console.log(
    `OpenRouter key usage delta (observed) ${spend}. $ per attempt is OpenCode's estimate. Skipped ${report.skipped}${report.stopped ? ` (stopped: ${report.stopped})` : ''}. ${report.incomplete ? 'INCOMPLETE: no endedAt, so planned attempts may be missing. NOT VALID.' : report.valid ? 'Valid.' : 'NOT VALID: unknown outcomes remain.'}`,
  );
}
