import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import haikuArm from './claude-haiku-5.5-claude-code-generic.ts';
import haiku from './claude-haiku-5.5-claude-code.ts';
import sonnetArm from './claude-sonnet-5.5-claude-code-generic.ts';
import sonnet from './claude-sonnet-5.5-claude-code.ts';
import { GENERIC_TASKS, genericPrompt } from './generic-prompts.ts';
import gptArm from './gpt-5.6-terra-codex-generic.ts';
import gpt from './gpt-5.6-terra-codex.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** Tooling instructions the generic prompts leave out. */
const TOOLING = ['tsc --noEmit', 'sanity schema extract', 'npm run build'];
const names = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ''));

test.each(GENERIC_TASKS)(
  '%s: the arm sends the generic prompt, which keeps every name and drops the tooling',
  (task) => {
    const frozen = read(`../evals/${task}/PROMPT.md`);
    const generic = read(`../prompts/generic/${task}.md`);
    expect(genericPrompt(frozen)).toBe(generic);
    for (const tool of TOOLING) expect(generic).not.toContain(tool);
    const kept = names(generic);
    for (const name of names(frozen))
      if (!TOOLING.includes(name)) expect(kept, `${task} keeps \`${name}\``).toContain(name);
  },
);

test('other prompts pass through unchanged, and an edited frozen prompt is not swapped', () => {
  const typegen = read('../evals/sanity-typegen/PROMPT.md');
  expect(genericPrompt(typegen)).toBe(typegen);
  const edited = `${read('../evals/sanity-singletons/PROMPT.md')} `;
  expect(genericPrompt(edited)).toBe(edited);
});

test.each([
  [haiku, haikuArm],
  [sonnet, sonnetArm],
  [gpt, gptArm],
])('each arm is its plain lane plus the generic prompts', (plain, arm) => {
  expect(plain.editPrompt).toBeUndefined();
  const { editPrompt, ...rest } = arm;
  expect(editPrompt).toBe(genericPrompt);
  expect(rest).toEqual(plain);
});
