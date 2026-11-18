import { openRouterExperiment } from './lib/openrouter.ts';

export default openRouterExperiment({ model: 'openai/gpt-5.6-terra', skills: true });
