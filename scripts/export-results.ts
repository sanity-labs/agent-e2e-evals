#!/usr/bin/env node
/**
 * Export eval results into the committed `published/` directory consumed by
 * the leaderboard.
 *
 * Reads `results/<experiment>/**\/summary.json`, picks the latest valid
 * result per eval, and writes:
 *
 *   published/agent-results.json                          flat leaderboard data
 *   published/<experiment>/<eval>/summary.json            latest summary
 *   published/<experiment>/<eval>/run-<N>/result.json     per-run o11y data
 *
 * Raw transcripts, outputs, and copied project files are NOT mirrored here —
 * they stay in the gitignored `results/` directory and can be uploaded as a
 * workflow artifact when debugging.
 *
 * Usage:
 *   pnpm run export-results              # export all experiments with results
 *   pnpm run export-results <exp> ...    # export only the named experiments
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

interface SummaryJson {
  totalRuns: number;
  passedRuns: number;
  passRate?: string;
  meanDuration: number;
  fingerprint?: string;
  valid?: boolean;
}

interface AgentResult {
  evalPath: string;
  result: {
    success: boolean;
    duration: number;
    evalPath: string;
    timestamp: string;
  };
}

interface ExportedData {
  metadata: {
    exportedAt: string;
    experiments: Array<{
      name: string;
      timestamp: string;
      modelName: string;
      agentHarness: string;
      avgDuration?: number;
    }>;
  };
  results: Record<string, AgentResult[]>;
}

const PUBLISHED_DIR = 'published';
const RESULTS_DIR = 'results';

const HARNESS_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  'vercel-ai-gateway/claude-code': 'Claude Code',
  'vercel-ai-gateway/codex': 'Codex',
  'vercel-ai-gateway/opencode': 'OpenCode',
};

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

async function isDirectory(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null);
  return s?.isDirectory() ?? false;
}

async function listDirEntries(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((e) => !e.startsWith('.'));
}

async function findTimestampDirs(dir: string): Promise<{ ts: string; dir: string }[]> {
  const entries = await listDirEntries(dir);
  const results: { ts: string; dir: string }[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (isTimestampDir(entry)) {
      results.push({ ts: entry, dir: full });
      continue;
    }
    if (await isDirectory(full)) {
      results.push(...(await findTimestampDirs(full)));
    }
  }
  return results;
}

async function hasAnySummary(dir: string): Promise<boolean> {
  const entries = await listDirEntries(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (!(await isDirectory(full))) continue;
    try {
      const s = await stat(join(full, 'summary.json'));
      if (s.isFile()) return true;
    } catch {
      // keep searching
    }
    if (await hasAnySummary(full)) return true;
  }
  return false;
}

async function getAgentHarness(experiment: string): Promise<string> {
  try {
    const configPath = join('experiments', `${experiment}.ts`);
    const content = await readFile(configPath, 'utf-8');
    const match = content.match(/agent:\s*['"]([^'"]+)['"]/);
    if (match) {
      return HARNESS_NAMES[match[1]] ?? match[1];
    }
  } catch {
    // Config may have been removed; fall through.
  }
  return 'Unknown';
}

async function copyJsonFile(src: string, dest: string): Promise<void> {
  const content = await readFile(src, 'utf-8');
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content.endsWith('\n') ? content : `${content}\n`);
}

async function copyEvalArtifacts(evalSrcDir: string, evalDestDir: string): Promise<void> {
  await copyJsonFile(join(evalSrcDir, 'summary.json'), join(evalDestDir, 'summary.json'));
  const entries = await listDirEntries(evalSrcDir);
  for (const entry of entries) {
    if (!/^run-\d+$/.test(entry)) continue;
    const resultSrc = join(evalSrcDir, entry, 'result.json');
    try {
      await stat(resultSrc);
    } catch {
      continue;
    }
    await copyJsonFile(resultSrc, join(evalDestDir, entry, 'result.json'));
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const resultsRoot = join(cwd, RESULTS_DIR);
  const publishedRoot = join(cwd, PUBLISHED_DIR);

  let experiments = process.argv.slice(2);

  if (experiments.length === 0) {
    const allDirs = await listDirEntries(resultsRoot);
    const withResults: string[] = [];
    for (const dir of allDirs) {
      if (dir.startsWith('_temp_')) continue;
      const full = join(resultsRoot, dir);
      if (!(await isDirectory(full))) continue;
      if (await hasAnySummary(full)) withResults.push(dir);
    }
    experiments = withResults.sort();
  }

  console.log(`Exporting from experiments: ${experiments.join(', ') || '(none)'}`);

  // Reset only the experiment subdirs we are about to write so stale evals are
  // pruned, but never remove an unrelated experiment's published data.
  for (const experiment of experiments) {
    await rm(join(publishedRoot, experiment), { recursive: true, force: true });
  }

  const exportedData: ExportedData = {
    metadata: {
      exportedAt: new Date().toISOString(),
      experiments: [],
    },
    results: {},
  };

  for (const experiment of experiments) {
    const expDir = join(resultsRoot, experiment);
    if (!(await isDirectory(expDir))) {
      console.warn(`Experiment not found: ${experiment}`);
      continue;
    }

    const timestampEntries = await findTimestampDirs(expDir);
    if (timestampEntries.length === 0) continue;

    const sortedEntries = timestampEntries.sort((a, b) => {
      const da = new Date(parseTimestamp(a.ts)).getTime();
      const db = new Date(parseTimestamp(b.ts)).getTime();
      return db - da;
    });

    const latestTimestamp = sortedEntries[0]!.ts;
    const agentResults: AgentResult[] = [];
    const seenEvals = new Set<string>();

    for (const { ts: timestamp, dir: runDir } of sortedEntries) {
      const evalDirs = await listDirEntries(runDir);
      for (const evalDir of evalDirs) {
        if (seenEvals.has(evalDir)) continue;
        const evalSrcDir = join(runDir, evalDir);
        const summaryPath = join(evalSrcDir, 'summary.json');
        let summary: SummaryJson;
        try {
          summary = JSON.parse(await readFile(summaryPath, 'utf-8'));
        } catch {
          continue;
        }
        if (summary.valid === false) continue;

        agentResults.push({
          evalPath: evalDir,
          result: {
            success: summary.passedRuns > 0,
            duration: summary.meanDuration * 1000,
            evalPath: evalDir,
            timestamp: parseTimestamp(timestamp),
          },
        });
        seenEvals.add(evalDir);

        const evalDestDir = join(publishedRoot, experiment, evalDir);
        await copyEvalArtifacts(evalSrcDir, evalDestDir);
      }
    }

    if (agentResults.length === 0) {
      console.warn(`No valid results for: ${experiment}`);
      continue;
    }

    const agentHarness = await getAgentHarness(experiment);
    const durations = agentResults.map((r) => r.result.duration);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length / 1000;

    exportedData.metadata.experiments.push({
      name: experiment,
      timestamp: parseTimestamp(latestTimestamp),
      modelName: experiment,
      agentHarness,
      avgDuration,
    });

    exportedData.results[experiment] = agentResults.sort((a, b) => a.evalPath.localeCompare(b.evalPath));
  }

  let totalSuccess = 0;
  let totalResults = 0;
  for (const results of Object.values(exportedData.results)) {
    for (const r of results) {
      totalResults++;
      if (r.result.success) totalSuccess++;
    }
  }

  await mkdir(publishedRoot, { recursive: true });
  const outputPath = join(publishedRoot, 'agent-results.json');
  await writeFile(outputPath, `${JSON.stringify(exportedData, null, 2)}\n`);

  console.log('-'.repeat(60));
  console.log(`Exported to: ${relative(cwd, outputPath)}`);
  console.log(`Total: ${totalResults} | Pass: ${totalSuccess} | Fail: ${totalResults - totalSuccess}`);
  console.log('-'.repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
