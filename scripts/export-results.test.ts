import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { exportRun, wilson } from './export-results.ts';

test('classifies attempts from the saved status and never guesses infra', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  const attempts: object[] = [];
  const attempt = (run: number, result?: object, testsRan = false, extra: object = {}) => {
    const outputDir = join(runDir, 'm', `demo-run-${run}`);
    if (result) {
      mkdirSync(join(outputDir, 'demo/run-1/outputs'), { recursive: true });
      writeFileSync(join(outputDir, 'demo/run-1/result.json'), JSON.stringify(result));
      if (testsRan) writeFileSync(join(outputDir, 'demo/run-1/outputs/eval.txt'), 'Tests ...');
    }
    const invocations = [{ status: 'failed', seconds: 100, costUsd: 0.01 }];
    attempts.push({ experiment: 'm', eval: 'demo', run, invocations, ...(result ? { outputDir } : {}), ...extra });
  };
  attempt(1, { status: 'passed', duration: 100, usage: { totalTokens: 1000 } }, true);
  attempt(2, { status: 'failed', duration: 100, usage: { inputTokens: 300, outputTokens: 200 } }, true);
  attempt(3, { status: 'failed', duration: 1800, error: 'Eval timed out after 1800s' });
  attempt(4, { status: 'failed', duration: 2, error: 'OpenRouter 429' }, false, {
    invocations: Array(6).fill({ status: 'failed', seconds: 2 }),
  });
  attempt(5, { status: 'failed', duration: 2, error: 'sandbox create failed' });
  attempt(6, undefined, false, { error: 'runExperiment threw' });
  attempt(7, { status: 'passed', duration: 100 }, true, {
    invocations: [
      { status: 'failed', seconds: 2 },
      { status: 'passed', seconds: 100 },
    ],
  });
  attempt(8, undefined, false, { skipped: 'batch spend reached the cap' });
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId: 'r1',
      attempts,
      stopped: 'batch spend reached the cap',
      openRouterUsageAtStart: 10,
      openRouterUsageAtEnd: 10.5,
    }),
  );
  writeFileSync(
    join(runDir, 'labels.json'),
    JSON.stringify({ 'm/demo/5': { outcome: 'infra', evidence: 'docker daemon down' } }),
  );

  const report = exportRun(runDir);
  expect(report.attempts.map((a) => [a.run, a.outcome])).toEqual([
    [1, 'pass'],
    [2, 'agent'],
    [3, 'agent'],
    [4, 'unknown'],
    [5, 'infra'],
    [6, 'unknown'],
    [7, 'unknown'], // passed only after a silent retry
  ]);
  expect(report.rows).toEqual([
    expect.objectContaining({ pass: 1, graded: 3, agent: 2, infra: 1, unknown: 3, retriedAttempts: 2 }),
  ]);
  expect(report).toMatchObject({ skipped: 1, valid: false, stopped: 'batch spend reached the cap' });
  expect(report.attempts.map((a) => a.tokens)).toEqual([1000, 500, null, null, null, null, null]);
  expect(report.rows[0]!.meanTokens).toBe(750);
  expect(report.openRouterUsageDeltaUsd).toBeCloseTo(0.5);
});

test('wilson interval matches a known value', () => {
  const [lo, hi] = wilson(7, 12);
  expect(lo).toBeCloseTo(0.3195, 3);
  expect(hi).toBeCloseTo(0.8067, 3);
});

test('a batch whose first spend check failed reports unknown spend, not all-time usage', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId: 'r2',
      attempts: [{ experiment: 'm', eval: 'demo', run: 1, invocations: [], skipped: 'spend check failed' }],
      stopped: 'spend check failed',
      openRouterUsageAtStart: null,
      openRouterUsageAtEnd: 42,
    }),
  );
  expect(exportRun(runDir).openRouterUsageDeltaUsd).toBeNull();
});

test('a copied batch still finds its attempts, for relative and older absolute paths', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  for (const run of [1, 2]) {
    mkdirSync(join(runDir, `m/demo-run-${run}/ts/demo/run-1/outputs`), { recursive: true });
    writeFileSync(join(runDir, `m/demo-run-${run}/ts/demo/run-1/result.json`), JSON.stringify({ status: 'passed' }));
    writeFileSync(join(runDir, `m/demo-run-${run}/ts/demo/run-1/outputs/eval.txt`), 'Tests ...');
  }
  const invocations = [{ status: 'passed', seconds: 1 }];
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId: 'r3',
      attempts: [
        { experiment: 'm', eval: 'demo', run: 1, invocations, outputDir: 'm/demo-run-1/ts' },
        { experiment: 'm', eval: 'demo', run: 2, invocations, outputDir: '/home/other/results/r3/m/demo-run-2/ts' },
      ],
      stopped: null,
      openRouterUsageAtStart: 0,
      openRouterUsageAtEnd: 0,
    }),
  );
  expect(exportRun(runDir).attempts.map((a) => a.outcome)).toEqual(['pass', 'pass']);
});

test('presentation and live content stay unknown whatever the saved status, unless a person labels them', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  const attempts: object[] = [];
  for (const evalName of ['sanity-presentation', 'sanity-live-content']) {
    for (const [run, status] of [
      [1, 'passed'],
      [2, 'failed'],
      [3, 'passed'],
    ] as const) {
      const outputDir = join(runDir, 'm', `${evalName}-run-${run}`);
      mkdirSync(join(outputDir, evalName, 'run-1/outputs'), { recursive: true });
      writeFileSync(join(outputDir, evalName, 'run-1/result.json'), JSON.stringify({ status }));
      writeFileSync(join(outputDir, evalName, 'run-1/outputs/eval.txt'), 'Tests ...');
      attempts.push({ experiment: 'm', eval: evalName, run, invocations: [{ status, seconds: 1 }], outputDir });
    }
  }
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId: 'r1', attempts, stopped: null }));
  // Run 3 of each task is reviewed by a person; the label wins.
  writeFileSync(
    join(runDir, 'labels.json'),
    JSON.stringify({
      'm/sanity-presentation/3': { outcome: 'pass', evidence: 'reviewed: overlays open the Studio' },
      'm/sanity-live-content/3': { outcome: 'agent', evidence: 'reviewed: posts never update' },
    }),
  );

  const report = exportRun(runDir);
  expect(report.attempts.map((a) => [a.eval, a.run, a.outcome])).toEqual([
    ['sanity-presentation', 1, 'unknown'],
    ['sanity-presentation', 2, 'unknown'],
    ['sanity-presentation', 3, 'pass'],
    ['sanity-live-content', 1, 'unknown'],
    ['sanity-live-content', 2, 'unknown'],
    ['sanity-live-content', 3, 'agent'],
  ]);
  expect(report.rows).toEqual([
    expect.objectContaining({ group: 'm × sanity-presentation', pass: 1, graded: 1, agent: 0, unknown: 2 }),
    expect.objectContaining({ group: 'm × sanity-live-content', pass: 0, graded: 1, agent: 1, unknown: 2 }),
  ]);
  expect(report.valid).toBe(false);
});
