import config from './claude-sonnet-4.6-mcp.js';

export default {
  ...config,
  runs: 1,
  timeout: 300,
  evals: 'mcp-smoketest',
  agentOptions: { effort: 'low' },
};
