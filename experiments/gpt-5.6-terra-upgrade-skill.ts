import { openRouterExperiment } from './lib/openrouter.ts';

// Studio upgrade full run: installs Sanity's sanity-studio-upgrade skill instead of best practices.
export default openRouterExperiment({ model: 'openai/gpt-5.6-terra', skill: 'sanity-studio-upgrade' });
