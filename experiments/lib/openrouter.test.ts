import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import plain from '../gpt-5.6-terra.ts';
import hinted, { SLUG_HINT } from '../gpt-5.6-terra-slug-hint.ts';

const prompt = readFileSync(new URL('../../evals/sanity-schema/PROMPT.md', import.meta.url), 'utf8');

test('the plain experiment leaves the prompt alone', () => {
  expect(plain.editPrompt).toBeUndefined();
});

test('the hint experiment adds exactly the hint as a final paragraph and changes nothing else', () => {
  const edited = hinted.editPrompt!(prompt);
  expect(edited).toBe(`${prompt.trimEnd()}\n\n${SLUG_HINT}\n`);
  expect(edited.startsWith(prompt.trimEnd())).toBe(true);
  const { editPrompt: _a, ...hintRest } = hinted;
  const { editPrompt: _b, ...plainRest } = plain;
  expect(JSON.stringify(hintRest)).toBe(JSON.stringify(plainRest));
});
