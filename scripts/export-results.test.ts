import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('presentation, live content and starter stay unknown whatever the saved status, unless a person labels them', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  const attempts: object[] = [];
  for (const evalName of ['sanity-presentation', 'sanity-live-content', 'sanity-nextjs-starter']) {
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
      'm/sanity-nextjs-starter/3': { outcome: 'pass', evidence: 'reviewed: home page fetched from its project' },
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
    ['sanity-nextjs-starter', 1, 'unknown'],
    ['sanity-nextjs-starter', 2, 'unknown'],
    ['sanity-nextjs-starter', 3, 'pass'],
  ]);
  expect(report.rows).toEqual([
    expect.objectContaining({ group: 'm × sanity-presentation', pass: 1, graded: 1, agent: 0, unknown: 2 }),
    expect.objectContaining({ group: 'm × sanity-live-content', pass: 0, graded: 1, agent: 1, unknown: 2 }),
    expect.objectContaining({ group: 'm × sanity-nextjs-starter', pass: 1, graded: 1, agent: 0, unknown: 2 }),
  ]);
  expect(report.valid).toBe(false);
});

test('table rows: saved vs completed, infra kept out of pass@1 with reasons, medians and totals, skills, files', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  const attempts: object[] = [];
  const step = (total: number) => JSON.stringify({ type: 'step_finish', part: { tokens: { total } } });
  const tool = (tool: string, input: object) => JSON.stringify({ type: 'tool_use', part: { tool, state: { input } } });
  const add = (experiment: string, run: number, seconds: number, costUsd: number, transcript: string[], files = 0) => {
    const outputDir = `${experiment}/demo-run-${run}/ts`;
    const dir = join(runDir, outputDir, 'demo/run-1');
    mkdirSync(join(dir, 'outputs'), { recursive: true });
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: run === 2 ? 'failed' : 'passed', usage: null }));
    writeFileSync(join(dir, 'outputs/eval.txt'), 'Tests ...');
    writeFileSync(join(dir, 'transcript-raw.jsonl'), `${transcript.join('\n')}\nnot json\n`);
    for (let f = 0; f < files; f++) {
      mkdirSync(join(dir, 'project/app'), { recursive: true });
      writeFileSync(join(dir, `project/app/f${f}.ts`), '');
    }
    attempts.push({ experiment, eval: 'demo', run, invocations: [{ status: 'x', seconds, costUsd }], outputDir });
  };
  add('m-skills', 1, 100, 0.1, [step(10), step(5), tool('skill', { name: 'sanity' })], 2);
  add('m-skills', 2, 300, 0.3, [step(40), tool('read', { filePath: '/w/.agents/skills/sanity/SKILL.md' })]);
  add('m-skills', 3, 200, 0.2, [step(20), tool('bash', { command: 'ls' })], 4);
  add('m', 1, 50, 0.05, [step(7)]);
  // Saved by run.ts at start, then the machine stopped: no runner result, so not completed or measured.
  attempts.push({ experiment: 'm', eval: 'demo', run: 3, invocations: [] });
  attempts.push({ experiment: 'm', eval: 'demo', run: 2, invocations: [], skipped: 'batch spend reached the cap' });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ runId: 'r4', attempts, stopped: 'cap' }));
  writeFileSync(
    join(runDir, 'labels.json'),
    JSON.stringify({ 'm-skills/demo/3': { outcome: 'infra', evidence: 'npm 404 during verifier install' } }),
  );
  const reportPath = join(mkdtempSync(join(tmpdir(), 'report-')), 'report.json');
  const report = exportRun(runDir, reportPath);

  expect(existsSync(join(runDir, 'report.json'))).toBe(false); // the run folder stays read-only
  expect(report.rows[0]).toMatchObject({
    group: 'm-skills × demo',
    planned: null,
    saved: 3,
    completed: 3,
    pass: 1,
    graded: 2,
    infra: 1,
    infraFailures: [{ run: 3, reason: 'labelled: npm 404 during verifier install' }],
    costUsd: { median: 0.2, known: 3 },
    tokens: { median: 20, total: 75, known: 3 },
    seconds: { median: 200, total: 600, known: 3 },
    skillsInstalled: true,
    skillUsed: 2,
    filesCaptured: { median: 3, total: 6, known: 2 },
  });
  expect(report.rows[0]!.costUsd.total).toBeCloseTo(0.6);
  expect(report.rows[1]).toMatchObject({
    group: 'm × demo',
    saved: 3,
    completed: 1,
    unknown: 1,
    seconds: { median: 50, total: 50, known: 1 },
    costUsd: { median: 0.05, total: 0.05, known: 1 },
    skillsInstalled: false,
    skillUsed: 0,
    filesCaptured: { median: null, total: null, known: 0 },
  });
});

test('an interrupted batch (no endedAt) shows planned attempts that never saved and is never valid', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'export-'));
  const outputDir = 'a/demo-run-1/ts';
  mkdirSync(join(runDir, outputDir, 'demo/run-1/outputs'), { recursive: true });
  writeFileSync(join(runDir, outputDir, 'demo/run-1/result.json'), JSON.stringify({ status: 'passed' }));
  writeFileSync(join(runDir, outputDir, 'demo/run-1/outputs/eval.txt'), 'Tests ...');
  const manifest = {
    runId: 'r5',
    experiments: [{ name: 'a' }, { name: 'b' }],
    evals: ['demo'],
    runsPerEval: 3,
    attempts: [{ experiment: 'a', eval: 'demo', run: 1, invocations: [{ status: 'passed', seconds: 1 }], outputDir }],
    stopped: null,
    endedAt: '',
  };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const report = exportRun(runDir, join(mkdtempSync(join(tmpdir(), 'report-')), 'report.json'));
  expect(report.rows.map((r) => [r.group, r.planned, r.saved, r.completed, r.pass])).toEqual([
    ['a × demo', 3, 1, 1, 1],
    ['b × demo', 3, 0, 0, 0],
  ]);
  expect(report).toMatchObject({ incomplete: true, valid: false });

  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ ...manifest, endedAt: '2026-10-29T10:00:00Z' }));
  expect(exportRun(runDir, join(mkdtempSync(join(tmpdir(), 'report-')), 'report.json'))).toMatchObject({
    incomplete: false,
    valid: true,
  });
});
