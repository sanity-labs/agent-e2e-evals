import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import plain from '../gpt-5.6-terra.ts';
import hinted, { SLUG_HINT } from '../gpt-5.6-terra-slug-hint.ts';

const prompt = readFileSync(new URL('../../evals/sanity-schema/PROMPT.md', import.meta.url), 'utf8');

test('the plain experiment leaves the prompt alone', () => {
  expect(plain.editPrompt).toBeUndefined();
});

test('the hint experiment adds exactly the hint as a final paragraph', () => {
  expect(hinted.editPrompt!(prompt)).toBe(`${prompt.trimEnd()}\n\n${SLUG_HINT}\n`);
});

test('apart from editPrompt, the two arms have the same keys, the same functions and equal values', () => {
  const { editPrompt: _a, ...h } = hinted as Record<string, unknown>;
  const p = plain as Record<string, unknown>;
  expect(Object.keys(h).sort()).toEqual(Object.keys(p).sort());
  for (const key of Object.keys(p)) {
    if (typeof p[key] === 'function') expect(h[key], key).toBe(p[key]); // same function object, e.g. setup, onRunComplete
    else expect(h[key], key).toStrictEqual(p[key]);
  }
});
