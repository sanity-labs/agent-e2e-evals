import { openRouterExperiment } from './lib/openrouter.ts';

// Studio upgrade full run: installs Sanity's sanity-studio-upgrade skill instead of best practices.
export default openRouterExperiment({ model: 'anthropic/claude-sonnet-5.5', skill: 'sanity-studio-upgrade' });
