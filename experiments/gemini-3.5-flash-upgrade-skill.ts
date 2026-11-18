import { openRouterExperiment } from './lib/openrouter.ts';

// Studio upgrade full run: installs Sanity's sanity-studio-upgrade skill instead of best practices.
export default openRouterExperiment({ model: 'google/gemini-3.5-flash', skill: 'sanity-studio-upgrade' });
