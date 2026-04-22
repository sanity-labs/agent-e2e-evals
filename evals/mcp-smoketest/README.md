# MCP Smoketest

Validates that an MCP experiment's Sanity MCP server config is correctly wired up. The agent must use the Sanity MCP server to list projects and write them to a file.

If this eval fails, the MCP server was not properly configured for the agent. Check:

- The experiment uses `sanityMcpSetup` from `experiments/lib/sanity-mcp-setup.ts`
- `SANITY_AUTH_TOKEN` is set in `.env`
- The agent's MCP config format is correct for the harness being tested

## Usage

Create a test experiment targeting only this eval:

```ts
import type { ExperimentConfig } from '@vercel/agent-eval';
import { sanityMcpSetup } from './lib/sanity-mcp-setup.js';

const config: ExperimentConfig = {
  agent: 'codex', // or 'claude-code', 'cursor', etc.
  model: 'gpt-5.4',
  scripts: [],
  runs: 1,
  evals: 'mcp-smoketest',
  setup: sanityMcpSetup,
};

export default config;
```

Then run: `npx @vercel/agent-eval <experiment-name> --smoke`
