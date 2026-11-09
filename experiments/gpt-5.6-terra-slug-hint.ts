import type { ExperimentConfig } from '@vercel/agent-eval';
import plain from './gpt-5.6-terra.ts';

// Schema v2 hint test: the plain GPT-5.6 Terra experiment, plus the one sentence we would propose for Sanity's docs,
// appended word for word as a final paragraph of the task prompt. Nothing else differs.
export const SLUG_HINT =
  'Adding `Rule.custom` to a slug field does not by itself replace the default uniqueness check. Use `options.isUnique` to change its scope, for example by language.';

const config: ExperimentConfig & { editPrompt: (prompt: string) => string } = {
  ...plain,
  editPrompt: (prompt: string) => `${prompt.trimEnd()}\n\n${SLUG_HINT}\n`,
};
export default config;
