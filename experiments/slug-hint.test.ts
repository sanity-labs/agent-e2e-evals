import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import hinted, { SLUG_HINT } from './gpt-5.6-terra-slug-hint.ts';
import plain from './gpt-5.6-terra.ts';

const prompt = readFileSync(new URL('../evals/sanity-schema/PROMPT.md', import.meta.url), 'utf8');

test('the hint arm is the plain arm plus an editPrompt that appends exactly the hint', () => {
  expect(plain.editPrompt).toBeUndefined();
  expect(hinted.editPrompt(prompt)).toBe(`${prompt.trimEnd()}\n\n${SLUG_HINT}\n`);
  const { editPrompt: _, ...hintRest } = hinted;
  expect(hintRest).toEqual(plain);
});
