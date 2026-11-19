import type { ExperimentConfig } from '@vercel/agent-eval';
import { genericPrompt } from './generic-prompts.ts';
import plain from './gpt-5.6-terra-codex.ts';

// The plain gpt-5.6-terra-codex experiment with the generic prompts (prompts/generic). Nothing else differs.
const config: ExperimentConfig & { editPrompt: (prompt: string) => string } = { ...plain, editPrompt: genericPrompt };
export default config;
