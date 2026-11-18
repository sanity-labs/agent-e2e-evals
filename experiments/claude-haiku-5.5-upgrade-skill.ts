import { openRouterExperiment } from './lib/openrouter.ts';

// Studio upgrade arm: installs Sanity's sanity-studio-upgrade skill instead of best practices.
export default openRouterExperiment({ model: 'anthropic/claude-haiku-5.5', skill: 'sanity-studio-upgrade' });
