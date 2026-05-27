# Published Eval Results

Each subdirectory is named by the ISO 8601 timestamp of the eval run and contains a single `summary.json`.

## `summary.json` format (version 1)

```jsonc
{
  "version": 1,
  "timestamp": "2026-05-20T20:52:49.341Z",
  "evalNames": [
    { "name": "sanity-groq", "displayName": "GROQ", "url": "https://github.com/sanity-labs/agent-e2e-evals/tree/main/evals/sanity-groq" },
    { "name": "sanity-live-content", "displayName": "Live Content", "url": "https://github.com/sanity-labs/agent-e2e-evals/tree/main/evals/sanity-live-content" },
    // ...
  ], // sorted list of all eval names
  "experiments": [
    {
      "name": "claude-opus-4.6", // experiment config filename (without .ts)
      "displayName": "Claude Opus 4.6", // human-readable model name
      "agentHarness": "Claude Code", // human-readable agent name
      "evalType": "baseline", // "baseline" | "mcp" | "skills"
      "averageScore": 0.9651, // pre-computed average of eval scores
      "evals": [
        {
          "name": "sanity-groq", // eval fixture name (folder in evals/)
          "displayName": "GROQ", // human-readable eval name
          "url": "https://github.com/sanity-labs/agent-e2e-evals/tree/main/evals/sanity-groq", // GitHub link to eval source
          "score": 0.9286, // 0-1, ratio of passed/total vitest assertions averaged across runs
          "duration": 359.5, // mean duration in seconds across runs
        },
      ],
    },
  ],
}
```

### Fields

- **`evalNames`** -- Sorted list of all eval names across experiments. Internal-only evals (e.g. `mcp-smoketest`) are excluded.
- **`displayName`** -- Human-readable model name, owned by this repo so consumers don't need their own mapping.
- **`url`** -- GitHub link to the eval's source directory in `evals/`.
- **`evalType`** -- What kind of run the experiment was: `"baseline"` (no tools), `"mcp"` (with Sanity MCP server), or `"skills"` (with agent skills).
- **`averageScore`** -- Pre-computed mean of the experiment's eval scores (internal evals excluded).

### Score calculation

Each eval's EVAL.ts contains multiple `test()` blocks (assertions). The score for one run is `passedTests / totalTests`. When an experiment runs multiple runs per eval, the final score is the average across all runs.

A score of `1` means every assertion passed in every run. A score of `0` means no assertions passed (or the agent failed before vitest could run).

## Generating results

```sh
pnpm run export-results
```
