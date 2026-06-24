# sanity-blueprints eval

Measures whether a coding agent can **scaffold a Sanity Blueprint by hand** — declaring a
Sanity Function wired to a document event and authoring the handler — **without running any
server-touching CLI command** (the blueprints `init` / `deploy` / `plan` subcommands).

Grading is fully static (`EVAL.ts` only reads files; it never calls Sanity), consistent with the
rest of the suite. The agent is steered away from server commands in `PROMPT.md`; `EVAL.ts` also
asserts no committed file or npm script invokes them.

## Status: not runnable until the blanks are filled

This fixture is a structural skeleton. The Blueprints-specific API names are intentionally left
blank so they can be filled from canonical Blueprints info. Until then, the dependent assertions
fail with explicit `TODO:` messages (so the eval reads as "not ready", not a false pass).

## Blanks to fill

| Where | What to provide |
| --- | --- |
| `EVAL.ts` → `FUNCTION_SDK_PACKAGE` (+ `FUNCTION_SDK_DTS`) | The package the handler imports from, and its installed `dist/*.d.ts` path (for the anti-hallucination check). |
| `EVAL.ts` → `BLUEPRINT_DEFINE_APIS` | Identifier(s) that define a Blueprint / declare resources (e.g. `defineBlueprint`). |
| `EVAL.ts` → `FUNCTION_RESOURCE_MARKERS` | Substring(s) proving the resource is a Sanity Function (e.g. its `type`/`kind` value). |
| `EVAL.ts` → `DOCUMENT_EVENT_MARKERS` | Substring(s) proving the doc-event trigger (the trigger key + event value). |
| `EVAL.ts` → `HANDLER_EXPORT_PATTERNS` | Pattern(s) matching the handler's export shape (default vs named). |
| `EVAL.ts` → `PINNED_PROJECT_ID` / `PINNED_DATASET` | Shared eval project + dataset; mirror the same values in `sanity.cli.ts`. |
| `EVAL.ts` → `FORBIDDEN_CLI` | Confirm/adjust the forbidden subcommands; confirm `doctor` (or whichever) is the allowed local-only command. |
| `PROMPT.md` | The concrete scenario (doc type, event, what the function does). |
| `sanity.cli.ts` | Replace `FILL_IN_PROJECT_ID` / `FILL_IN_DATASET` (or move the pin to wherever Blueprints canonically configures project/dataset). |
| `package.json` → `dependencies` | Add the function-SDK package (the thing the handler imports). The CLI itself ships via `sanity`, already present. |
| `tsconfig.json` | Align module/runtime settings with the canonical Functions toolchain if needed; `build` is `tsc --noEmit` (local-only). Optionally switch to `tsc --noEmit && sanity blueprints doctor` once you've confirmed `doctor` makes no network calls. |

## After filling the blanks

1. Generate the committed lockfile (offline-deterministic install in the sandbox):
   ```bash
   cd evals/sanity-blueprints && pnpm install
   ```
   Commit the resulting `pnpm-lock.yaml`.
2. Sanity-check the local build on the starter fixture:
   ```bash
   pnpm build   # tsc --noEmit
   ```

## Running

- Fast grader-only loop (skips install + build; the SDK/import checks no-op):
  ```bash
  pnpm test-eval sanity-blueprints --model claude-opus-4-8 --runs 1
  ```
- Full pipeline (install → build → grade), via a real experiment filtered to this eval:
  ```bash
  pnpm agent-eval claude-opus-4.8
  ```

The eval auto-runs across all experiments (the `nonMcpEvals` filter only excludes `mcp-smoketest`)
and is published (it is registered in `scripts/export-results.ts` and is not in `INTERNAL_EVALS`).
