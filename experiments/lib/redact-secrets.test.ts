import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvalSummary, createExperimentResults, saveResults } from '@vercel/agent-eval';
import { expect, test } from 'vitest';
import { redactSecrets } from './redact-secrets.ts';

test('saved starter files keep app source and binary bytes and drop env files', async () => {
  const fakeToken = `sk${'F'.repeat(70)}`; // shape of a Sanity token, never a real one
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const runData = {
    result: { status: 'passed' as const, duration: 1 },
    generatedFiles: {
      'app/frontend/.env.local': Buffer.from(`SANITY_API_READ_TOKEN=${fakeToken}\n`),
      'app/.env': Buffer.from('NEXT_PUBLIC_SANITY_PROJECT_ID=abc123xy\n'),
      'app/sanity/env.ts': Buffer.from('export const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET\n'),
      'app/public/logo.png': png,
      'notes.txt': Buffer.from('outside app/'),
    },
    deletedFiles: ['app/.env.example', 'app/old.ts'],
  };
  const config = { copyFiles: 'changed' } as Parameters<typeof redactSecrets>[0]['config'];
  const filtered = await redactSecrets({ config, runData, fixture: {} as never, runIndex: 0 });

  // Through agent-eval's own writer, as a run would save it.
  const resultsDir = mkdtempSync(join(tmpdir(), 'capture-'));
  const results = createExperimentResults(
    { ...config, copyFiles: 'changed' } as never,
    [createEvalSummary('sanity-nextjs-starter', [filtered!])],
    new Date(0),
    new Date(1),
  );
  const out = saveResults(results, { resultsDir, experimentName: 'm' });
  const project = join(out, 'sanity-nextjs-starter/run-1/project');

  expect(existsSync(join(project, 'app/frontend/.env.local'))).toBe(false);
  expect(existsSync(join(project, 'app/.env'))).toBe(false);
  expect(existsSync(join(project, 'notes.txt'))).toBe(false);
  expect(readFileSync(join(project, 'app/sanity/env.ts'), 'utf8')).toContain('NEXT_PUBLIC_SANITY_DATASET');
  expect(readFileSync(join(project, 'app/public/logo.png')).equals(png)).toBe(true);
  expect(filtered!.deletedFiles).toEqual(['app/old.ts']);
});
