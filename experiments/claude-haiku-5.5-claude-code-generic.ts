import type { ExperimentConfig } from '@vercel/agent-eval';
import plain from './claude-haiku-5.5-claude-code.ts';
import { genericPrompt } from './generic-prompts.ts';

// The plain claude-haiku-5.5-claude-code experiment with the generic prompts (prompts/generic). Nothing else differs.
const config: ExperimentConfig & { editPrompt: (prompt: string) => string } = { ...plain, editPrompt: genericPrompt };
export default config;
