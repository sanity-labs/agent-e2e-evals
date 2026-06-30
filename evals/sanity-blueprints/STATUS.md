# sanity-blueprints eval — status & next steps

_Last updated: 2026-06-25 (Taylor Beseda)_

## TL;DR

The skeleton's blanks are **filled from canonical Blueprints material** and the eval is **runnable
and validated locally** (bare starter 4/8, canonical solution 8/8, all root CI gates green). It is
not yet "live" pending a version-pin refresh and Taylor's branch + commit.

## Why we resumed

The earlier pause was on an open question: is this suite actually run/consumed anywhere? Update from
Taylor (2026-06-25): **evals aren't on a schedule yet, but they will be.** This work is deliberately
*ahead of the game* — getting Blueprints coverage ready so it can be turned on later. We're filling
canonical blanks from real upcoming capabilities (the local `blueprints/product` reference
material), not building exhaustive coverage against behavior we can't yet prove.

## What's done (this session)

- **Filled all `EVAL.ts` blanks** from canonical sources (the `blueprints/product` 2025-05-05 Notion
  export + `sites/stack-patterns/starters/`), not docs/priors:
  - `FUNCTION_SDK_PACKAGE = '@sanity/functions'`; `BLUEPRINT_DEFINE_APIS = [defineBlueprint, defineDocumentFunction]`;
    `FUNCTION_RESOURCE_MARKERS = [defineDocumentFunction, sanity.function.document]`;
    handler export patterns; pinned `xg4e0byh`/`production`.
  - Tightened the doc-event check from weak OR-substrings to a regex (`on:` array of a real event).
  - Refined `FORBIDDEN_CLI` to the real server-touching set; dropped the nonexistent `functions deploy`.
  - **Fixed a real grader bug:** the anti-hallucination test parsed only `index.d.ts`, but
    `@sanity/functions` ships a barrel (`export * from './definers.js'`) — a correct
    `documentEventHandler` import would have been falsely flagged. It now follows re-exports.
- **Removed `sanity.cli.ts`** (a Studio convention, not Blueprints — and it would break `tsc` once
  the `sanity` dep was dropped). The project is now pinned the canonical way, in the blueprint's
  `values` in `sanity.blueprint.ts`.
- **`package.json`:** dropped placeholder `sanity ^5.30.0`; added `@sanity/blueprints`,
  `@sanity/functions`, `@sanity/client` (+ dev `@sanity/runtime-cli`). Generated `pnpm-lock.yaml`.
- **`tsconfig.json`:** aligned to the canonical Functions toolchain (`module ESNext`, `moduleResolution bundler`).
- **`PROMPT.md`:** concrete scenario — on publish of a `post`, set `slug` from `title` when missing.
  Updated guardrails (doctor is now forbidden, since it reads remote scope).
- **Validated locally:** starter `tsc --noEmit` clean; grader baseline **4/8**; a canonical
  hand-written solution `tsc` clean + **8/8**; root `pnpm typecheck` / `lint` / `format` all green.
- No git operations performed — Taylor will branch and commit (incl. the `sanity.cli.ts` deletion,
  `pnpm-lock.yaml`, and this file).

## What's NOT done (resume here)

1. **Refresh the version pins.** The deps are from the ~May-2025 starter authoring and lag current
   releases (pnpm flags blueprints 0.21 / client 7 / runtime-cli 17). They install + type-check
   today, but confirm the right pins and re-run `pnpm install` before turning the eval on.
2. **Branch + commit** the fixture (Taylor).
3. **Verify `FUNCTION_SDK_DTS` still resolves** if `@sanity/functions` is bumped (the path is
   `dist/index.d.ts`; the check no-ops if absent, silently disabling it).

## Deferred (out of scope for now)

- **Live deploy + behavioral verification** (does the function actually set the slug). Needs a
  deploy+execute path; explicitly deferred while the suite is static-only.
- **Operationalizing the run→publish→consume pipeline** (schedule, harness-health gate vs. agent
  scores, the known full-matrix OOM). Relevant once "turn on evals" actually happens.
