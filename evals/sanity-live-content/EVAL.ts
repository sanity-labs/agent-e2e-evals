import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { test, expect } from 'vitest';

// Locate the live-content utility by filename anywhere under src/. The
// conventional home is `src/sanity/lib/live.ts`, but a solution that placed it
// at `src/sanity/live.ts` (or another src/ subfolder) is equally valid, so we
// don't hard-code the directory. When multiple `live.{ts,tsx}` files exist,
// prefer the one that actually wires up Live Content via `defineLive`.
async function findLiveFile(): Promise<string | undefined> {
  const candidates: string[] = [];
  for await (const filePath of fs.glob('src/**/live.{ts,tsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    candidates.push(filePath);
  }
  for (const filePath of candidates) {
    const content = await fs.readFile(filePath, 'utf-8').catch(() => undefined);
    if (content && /defineLive/.test(content)) return filePath;
  }
  return candidates[0];
}

const livePath = await findLiveFile();

test('live content utility file exists', () => {
  expect(
    livePath,
    'expected a live-content utility (e.g. `src/sanity/lib/live.ts`) that calls `defineLive`',
  ).not.toBeUndefined();
});

test('live utility uses defineLive from next-sanity/live', () => {
  expect(livePath).not.toBeUndefined();
  const content = readFileSync(livePath!, 'utf-8');
  expect(content).toMatch(/defineLive/);
  expect(content).toMatch(/next-sanity\/live/);
});

test('live utility exports sanityFetch and SanityLive', () => {
  expect(livePath).not.toBeUndefined();
  const content = readFileSync(livePath!, 'utf-8');
  expect(content).toMatch(/sanityFetch/);
  expect(content).toMatch(/SanityLive/);
});

test('live utility configures a server token', () => {
  expect(livePath).not.toBeUndefined();
  const content = readFileSync(livePath!, 'utf-8');
  expect(content).toMatch(/serverToken/);
});

test('posts page uses sanityFetch instead of client.fetch', () => {
  const content = readFileSync('src/app/posts/page.tsx', 'utf-8');
  expect(content).toMatch(/sanityFetch/);
  expect(content).not.toMatch(/client\.fetch/);
});

test('root layout includes SanityLive component', () => {
  const content = readFileSync('src/app/layout.tsx', 'utf-8');
  expect(content).toMatch(/<SanityLive\s*\/?>/);
});
