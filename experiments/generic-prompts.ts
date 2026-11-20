import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Generic prompt arm (AIGRO-5685, from Jonah's review of the schema and Portable Text evals): the same tasks asked the
// way a user would, with no tooling instructions such as "make sure `tsc --noEmit` passes". The frozen prompts in
// evals/*/PROMPT.md stay as they are, and grading is unchanged. The generic text lives outside evals/ because
// agent-eval copies every fixture file except PROMPT.md and EVAL.ts into the agent's sandbox.
export const GENERIC_TASKS = ['sanity-webhook', 'sanity-draft-preview'] as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The generic prompt for each frozen prompt, keyed by the frozen prompt's hash (editPrompt only gets the text). */
const GENERIC = new Map(
  GENERIC_TASKS.map((task) => [sha256(read(`../evals/${task}/PROMPT.md`)), read(`../prompts/generic/${task}.md`)]),
);

/** Swaps a frozen prompt for its generic version; other tasks keep their prompt. */
export function genericPrompt(prompt: string): string {
  return GENERIC.get(sha256(prompt)) ?? prompt;
}
