# Published Eval Results

Each subdirectory is named by the ISO 8601 timestamp of the eval run and contains a single `summary.json`.

## `summary.json` format (version 1)

```jsonc
{
  "version": 1,
  "timestamp": "2026-05-20T20:52:49.341Z",
  "evals": [
    { "name": "sanity-groq", "displayName": "GROQ", "url": "https://github.com/sanity-labs/agent-e2e-evals/tree/main/evals/sanity-groq" },
    { "name": "sanity-live-content", "displayName": "Live Content", "url": "https://github.com/sanity-labs/agent-e2e-evals/tree/main/evals/sanity-live-content" },
    // ...
  ], // sorted list of all eval names
  "models": [
    {
      "name": "claude-opus-4.6", // stable model identifier
      "displayName": "Claude Opus 4.6", // human-readable model name
      "agentHarness": "Claude Code", // human-readable agent name
      "variants": {
        "baseline": {
          "experimentName": "claude-opus-4.6", // experiment config filename (without .ts)
          "thinkingLevel": "high", // optional model thinking level
          "iterations": 8, // maximum run count across evals in this variant
          "average": {
            "score": 0.9651, // mean score across eval averages
            "duration": 359.5, // mean duration in seconds across eval averages, or null if unknown
          },
          "evals": {
            "sanity-groq": {
              "average": {
                "score": 0.9286, // mean score across runs
                "duration": 359.5, // mean duration in seconds across runs, or null if unknown
              },
              "runs": [
                {
                  "score": 1, // 0-1, ratio of passed/total vitest assertions for this run
                  "duration": 341.2, // run duration in seconds, or null if unknown
                },
              ],
            },
          },
        },
        "mcp": {
          // same shape as baseline
        },
        "skills": {
          // same shape as baseline
        },
      },
    },
  ],
}
```

### Fields

- **`evals`** -- Sorted list of all evals across models and variants. Internal-only evals (e.g. `mcp-smoketest`) are excluded.
- **`models`** -- Results grouped by model. Each model has required `baseline`, `mcp`, and `skills` variants.
- **`variants`** -- Variant results keyed by run type: `"baseline"` (no tools), `"mcp"` (with Sanity MCP server), and `"skills"` (with agent skills).
- **`average`** -- Pre-computed aggregate stats with the same shape as each entry in `runs`: `{ "score": number, "duration": number | null }`.
- **`runs`** -- Per-run stats for an eval. Empty when only legacy summary-level pass/fail data is available.
- **`displayName`** -- Human-readable model or eval name, owned by this repo so consumers don't need their own mapping.
- **`url`** -- GitHub link to the eval's source directory in `evals/`.

### Score calculation

Each eval's EVAL.ts contains multiple `test()` blocks (assertions). The score for one run is `passedTests / totalTests`. An eval's `average.score` is the average across its runs. A variant's `average.score` is the average of its eval averages.

A score of `1` means every assertion passed in every run. A score of `0` means no assertions passed (or the agent failed before vitest could run).

## Generating results

```sh
pnpm run export-results
```
