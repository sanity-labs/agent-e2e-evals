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
  attempt(1, { status: 'passed', duration: 100, o11y: { usage: { totalTokens: 1000 } } }, true);
  attempt(2, { status: 'failed', duration: 100 }, true);
  attempt(3, { status: 'failed', duration: 1800, error: 'Eval timed out after 1800s' });
  attempt(4, { status: 'failed', duration: 2, error: 'OpenRouter 429' }, false, {
    invocations: Array(6).fill({ status: 'failed', seconds: 2 }),
  });
  attempt(5, { status: 'failed', duration: 2, error: 'sandbox create failed' });
  attempt(6, undefined, false, { error: 'runExperiment threw' });
  attempt(7, undefined, false, { skipped: 'batch spend reached the cap' });
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
  ]);
  expect(report.rows).toEqual([
    expect.objectContaining({ pass: 1, graded: 3, agent: 2, infra: 1, unknown: 2, retriedAttempts: 1 }),
  ]);
  expect(report).toMatchObject({ skipped: 1, valid: false, stopped: 'batch spend reached the cap' });
  expect(report.openRouterSpendUsd).toBeCloseTo(0.5);
});

test('wilson interval matches a known value', () => {
  const [lo, hi] = wilson(7, 12);
  expect(lo).toBeCloseTo(0.3195, 3);
  expect(hi).toBeCloseTo(0.8067, 3);
});
