import { openRouterExperiment } from './lib/openrouter.ts';

// Schema v2 hint test: the task prompt plus the one sentence we would propose for Sanity's docs, word for word.
export const SLUG_HINT =
  'Adding `Rule.custom` to a slug field does not by itself replace the default uniqueness check. Use `options.isUnique` to change its scope, for example by language.';

export default openRouterExperiment({ model: 'openai/gpt-5.6-terra', promptSuffix: SLUG_HINT });
