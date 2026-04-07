# Scoring & Leaderboard Plan

## Problem

The `@vercel/agent-eval` framework reports evals as binary pass/fail. An eval with 5/7 tests passing and 1/7 tests passing both show as "0/1 passed (0%)". We need partial scores to:

- Compare baseline vs MCP experiments meaningfully
- Build a leaderboard showing percentage scores per agent/model
- Track improvement over time as we add more evals

## Current data

The framework already captures per-test results in `eval.txt`:

```
EVAL.ts (7 tests | 2 failed) 1877ms
  × live utility uses defineLive from next-sanity/live
  ✓ live utility exports sanityFetch and SanityLive
  ✓ live utility configures a server token
  ...
```

And structured data in `result.json`:

```json
{
  "status": "failed",
  "duration": 85.2,
  "model": "claude-sonnet-4-5"
}
```

## Proposed solution

A `scripts/score.ts` script that:

1. **Walks `results/`** — discovers all experiment/model/timestamp/eval/run directories
2. **Parses `eval.txt`** — extracts individual test pass/fail from vitest output
3. **Computes scores** — `passed_tests / total_tests` per run, averaged across runs
4. **Outputs a leaderboard** — table sorted by score, showing:
   - Experiment name
   - Model
   - Score (0-100%)
   - Tests passed / total
   - Pass rate (full eval pass/fail, for reference)
   - Duration (mean)

### Example output

```
Experiment                  Model             Score   Tests      Pass Rate   Duration
claude-sonnet-4.5-mcp       claude-sonnet-4-5  71.4%   5/7        0/1         85s
claude-sonnet-4.6-mcp       claude-sonnet-4-6  85.7%   6/7        0/1         80s
claude-sonnet-4.6           claude-sonnet-4-6  71.4%   5/7        0/1         80s
claude-sonnet-4.5           claude-sonnet-4-5  14.3%   1/7        0/1         211s
```

### Comparison mode

When experiments come in pairs (baseline + mcp), show the delta:

```
Model              Baseline   MCP      Delta
claude-sonnet-4-5   14.3%     71.4%    +57.1%
claude-sonnet-4-6   71.4%     85.7%    +14.3%
```

## Parsing strategy

The vitest output in `eval.txt` follows a consistent format:

- `✓ test name` — passed
- `× test name` — failed
- Summary line: `Tests  N failed | M passed (T)`

Parse the summary line with a regex like:
```
/Tests\s+(\d+)\s+failed\s+\|\s+(\d+)\s+passed\s+\((\d+)\)/
```

## Multiple runs

When an experiment has multiple runs (runs: 4 with earlyExit), take the **best run** for scoring. Rationale: earlyExit means the framework stops on first full pass, so partial failures in early runs are expected. The best run represents the agent's capability.

## Multiple timestamps

When an experiment has been run multiple times (multiple timestamp dirs), use the **latest** timestamp by default. Add a `--all` flag to show history.

## Edge cases

- Docker/infra failures (duration: 0, no eval.txt) — skip, don't count
- Missing eval.txt — skip run
- Eval with no tests — skip

## Implementation

- Single file: `scripts/score.ts`
- Run with: `npx tsx scripts/score.ts`
- Flags:
  - `--json` — output as JSON for downstream consumption
  - `--all` — show all timestamps, not just latest
  - `--compare` — show baseline vs MCP delta table

## Future

- Write JSON output to `scores.json` for a web dashboard
- Add to CI to auto-generate after runs
- Could feed into Braintrust if we add that integration later
