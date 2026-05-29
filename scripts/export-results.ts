#!/usr/bin/env node
/**
 * Export eval results into the committed `published/` directory.
 *
 * Reads all experiments in `results/`, merges across timestamps (newest-first)
 * to get the full eval set per experiment, and writes a single summary JSON:
 *
 *   published/<datetime>/summary.json
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface SummaryJson {
  totalRuns: number;
  passedRuns: number;
  passRate?: string;
  meanDuration: number;
  fingerprint?: string;
  valid?: boolean;
}

type EvalType = 'baseline' | 'mcp' | 'skills';

interface EvalResult {
  name: string;
  displayName: string;
  url: string;
  score: number;
  duration: number;
}

interface ExperimentResult {
  name: string;
  displayName: string;
  agentHarness: string;
  evalType: EvalType;
  averageScore: number;
  evals: EvalResult[];
}

interface ExportedSummary {
  version: 1;
  timestamp: string;
  evalNames: Array<{ name: string; displayName: string; url: string }>;
  experiments: ExperimentResult[];
}

const ROOT_DIR = join(import.meta.dirname, '..');
const RESULTS_DIR = join(ROOT_DIR, 'results');
const PUBLISHED_DIR = join(ROOT_DIR, 'published');

const HARNESS_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  'vercel-ai-gateway/claude-code': 'Claude Code',
  'vercel-ai-gateway/codex': 'Codex',
  'vercel-ai-gateway/opencode': 'OpenCode',
};

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-opus-4.6': 'Claude Opus 4.6',
  'claude-opus-4.7': 'Claude Opus 4.7',
  'claude-opus-4.8': 'Claude Opus 4.8',
  'claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'cursor-composer-2.0': 'Cursor Composer 2.0',
  'cursor-composer-2.5': 'Cursor Composer 2.5',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.5': 'GPT-5.5',
};

const EVAL_DISPLAY_NAMES: Record<string, string> = {
  'sanity-groq': 'GROQ',
  'sanity-live-content': 'Live Content',
  'sanity-nextjs-starter': 'Next.js Starter',
  'sanity-presentation': 'Presentation Mode',
  'sanity-typegen': 'TypeGen',
};

const INTERNAL_EVALS = new Set(['mcp-smoketest']);

const EVAL_BASE_URL = 'https://github.com/sanity-labs/agent-e2e-evals/tree/main/evals';

function getEvalType(experimentName: string): EvalType {
  if (experimentName.endsWith('-skills')) return 'skills';
  if (experimentName.endsWith('-mcp')) return 'mcp';
  return 'baseline';
}

function getBaseExperimentName(experimentName: string): string {
  return experimentName.replace(/-(mcp|skills)$/, '');
}

function getDisplayName(experimentName: string): string {
  const base = getBaseExperimentName(experimentName);
  return MODEL_DISPLAY_NAMES[base] ?? base;
}

function parseTimestamp(ts: string): string {
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)Z$/);
  if (match) {
    return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  }
  return ts;
}

function isTimestampDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(name);
}

async function listSubdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function getAgentHarness(experiment: string): Promise<string> {
  try {
    const configPath = join('experiments', `${experiment}.ts`);
    const content = await readFile(configPath, 'utf-8');
    const match = content.match(/agent:\s*['"]([^'"]+)['"]/);
    if (match?.[1]) {
      return HARNESS_NAMES[match[1]] ?? match[1];
    }
  } catch {
    // Config may have been removed; fall through.
  }
  return 'Unknown';
}

/**
 * Parse vitest text output to extract passed/total test counts.
 * Handles all vitest summary line formats:
 *   "Tests  7 passed (7)"
 *   "Tests  1 failed | 6 passed (7)"
 *   "Tests  6 failed (6)"
 * Returns the score as a ratio (0-1), or null if unparseable.
 */
function parseVitestScore(output: string): number | null {
  const summaryMatch = output.match(/^\s*Tests\s+(.+)\((\d+)\)/m);
  if (!summaryMatch?.[1] || !summaryMatch[2]) return null;
  const total = Number(summaryMatch[2]);
  if (total === 0) return null;

  const passedMatch = summaryMatch[1].match(/(\d+)\s+passed/);
  const passed = passedMatch ? Number(passedMatch[1]) : 0;

  return passed / total;
}

/**
 * Compute the average assertion-level score across all runs in an eval directory.
 * Reads outputs/eval.txt from each run-N/ subdirectory to parse vitest results.
 *
 * A run that produced no parseable eval output (it timed out or crashed before
 * the assertions ran) counts as 0 — a timeout means the agent didn't finish in
 * time, which is a failure, not a run to silently drop. Falls back to the
 * binary pass/fail from summary.json only when there are no run directories.
 */
async function computeEvalScore(evalSrcDir: string, summary: SummaryJson): Promise<number> {
  const runDirs = (await listSubdirs(evalSrcDir)).filter((e) => /^run-\d+$/.test(e)).sort();

  if (runDirs.length === 0) {
    return summary.passedRuns > 0 ? 1 : 0;
  }

  const scores: number[] = [];
  for (const runDir of runDirs) {
    const evalOutputPath = join(evalSrcDir, runDir, 'outputs', 'eval.txt');
    let score = 0;
    try {
      const output = await readFile(evalOutputPath, 'utf-8');
      score = parseVitestScore(output) ?? 0;
    } catch {
      // No eval output for this run -> failed/timed-out run, scored as 0.
    }
    scores.push(score);
  }

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * For a given experiment, find all timestamp dirs sorted newest-first
 * and collect the latest valid result for each eval (merging across timestamps).
 */
async function collectExperimentEvals(expDir: string): Promise<EvalResult[]> {
  const timestampDirs = (await listSubdirs(expDir)).filter(isTimestampDir).sort().reverse();

  const results: EvalResult[] = [];
  const seenEvals = new Set<string>();

  for (const tsDir of timestampDirs) {
    const tsPath = join(expDir, tsDir);

    const evalDirs = await listSubdirs(tsPath);
    for (const evalDir of evalDirs) {
      if (seenEvals.has(evalDir) || INTERNAL_EVALS.has(evalDir)) continue;
      const evalSrcDir = join(tsPath, evalDir);

      const summaryPath = join(evalSrcDir, 'summary.json');
      const summary: SummaryJson = JSON.parse(await readFile(summaryPath, 'utf-8'));
      if (summary.valid === false) continue;

      const score = await computeEvalScore(evalSrcDir, summary);

      results.push({
        name: evalDir,
        displayName: EVAL_DISPLAY_NAMES[evalDir] ?? evalDir,
        url: `${EVAL_BASE_URL}/${evalDir}`,
        score,
        duration: summary.meanDuration,
      });
      seenEvals.add(evalDir);
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get the latest timestamp directory name for an experiment.
 */
async function getLatestTimestamp(expDir: string): Promise<string | undefined> {
  const timestamps = (await listSubdirs(expDir)).filter(isTimestampDir);
  timestamps.sort();
  return timestamps.at(-1);
}

// Discover all experiment directories with results
const allExpDirs = (await listSubdirs(RESULTS_DIR)).filter((d) => !d.startsWith('_temp_'));
const expWithTimestamps: Array<{ name: string; latestTs: string }> = [];
for (const dir of allExpDirs) {
  const ts = await getLatestTimestamp(join(RESULTS_DIR, dir));
  if (ts) expWithTimestamps.push({ name: dir, latestTs: ts });
}

const experiments = expWithTimestamps.map((e) => e.name).sort();

console.log(`Exporting ${experiments.length} experiment(s): ${experiments.join(', ') || '(none)'}`);

// Build the summary
const experimentResults: ExperimentResult[] = [];

for (const experiment of experiments) {
  const expDir = join(RESULTS_DIR, experiment);

  const evals = await collectExperimentEvals(expDir);
  if (evals.length === 0) {
    console.warn(`No valid results for: ${experiment}`);
    continue;
  }

  const agentHarness = await getAgentHarness(experiment);
  const averageScore = evals.length > 0 ? evals.reduce((sum, e) => sum + e.score, 0) / evals.length : 0;

  experimentResults.push({
    name: experiment,
    displayName: getDisplayName(experiment),
    agentHarness,
    evalType: getEvalType(experiment),
    averageScore,
    evals,
  });
}

// Use the global latest timestamp as the export directory name
const latestTs =
  expWithTimestamps
    .filter((e) => experiments.includes(e.name))
    .map((e) => e.latestTs)
    .sort()
    .at(-1) ?? new Date().toISOString().replace(/:/g, '-');

const exportDir = join(PUBLISHED_DIR, latestTs);
await mkdir(exportDir, { recursive: true });

const evalNamesSet = new Set<string>(experimentResults.flatMap((exp) => exp.evals.map((ev) => ev.name)));
const evalNames = evalNamesSet
  .values()
  .map((name) => ({ name, displayName: EVAL_DISPLAY_NAMES[name] ?? name, url: `${EVAL_BASE_URL}/${name}` }))
  .toArray();

const summary: ExportedSummary = {
  version: 1,
  timestamp: parseTimestamp(latestTs),
  evalNames,
  experiments: experimentResults,
};

const outputPath = join(exportDir, 'summary.json');
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

// Print stats
const totalEvals = experimentResults.reduce((sum, exp) => sum + exp.evals.length, 0);
const avgScore =
  experimentResults.length > 0
    ? experimentResults.reduce((sum, exp) => sum + exp.averageScore, 0) / experimentResults.length
    : 0;

console.log('-'.repeat(60));
console.log(`Exported to: ${relative(ROOT_DIR, outputPath)}`);
console.log(
  `Experiments: ${experimentResults.length} | Evals: ${totalEvals} | Avg score: ${(avgScore * 100).toFixed(1)}%`,
);
console.log('-'.repeat(60));
