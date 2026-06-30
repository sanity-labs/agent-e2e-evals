# sanity-blueprints eval

Measures whether a coding agent can **scaffold a Sanity Blueprint by hand** — declaring a
Sanity Function wired to a document event and authoring the handler — **without running any
server-touching CLI command** (the blueprints `init` / `plan` / `deploy` / `destroy` / `info` /
`logs` / `doctor` subcommands, or `functions env`).

## Scenario

A minimal Blueprints workspace already pinned to a project (`sanity.blueprint.ts`). The task: add a
document Function that, **on publish of a `post`**, derives a URL-friendly `slug` from `title` when
the slug is missing, and patches it back. The agent declares the function resource in the blueprint
and writes the handler by hand under `functions/<name>/index.ts`.

## What the grader checks

1. Declares a Blueprint via a definition API (`defineBlueprint`).
2. Declares a Sanity document Function (`defineDocumentFunction`, or the raw `sanity.function.document` type).
3. Wires it to a document event (an `on:` array of `publish`/`create`/`update`/`delete`).
4. Exports a handler (`export const handler = documentEventHandler<…>(…)`).
5. Keeps server-touching commands out of the auto-run `build`/lifecycle scripts (standalone `deploy`/`plan` scripts are fine).
6. Imports only real symbols from `@sanity/functions`.
7. Preserves the pinned project (`xg4e0byh`) and dataset (`production`).
8. Replaced the starter `TODO(blueprints-eval)` stub.

Baseline: the bare starter scores **4/8** (it already has `defineBlueprint`, the pinned target, no
forbidden commands, and no hallucinated imports). A correct solution scores **8/8** — verified
locally with a canonical handler.

## Canonical sources & caveats

The Blueprints/Functions specifics are from Sanity documentation.

- `@sanity/blueprints` → `defineBlueprint`, `defineDocumentFunction` (+ `defineCorsOrigin`, `defineRobotToken`, …).
- `@sanity/functions` → `documentEventHandler`. Handler envelope is `{context, event}`; `event.data` is the (optionally projected) document; `context.clientOptions` feeds `@sanity/client`'s `createClient`.
- Function source lives at `functions/<resource-name>/index.ts`; the CLI infers `src` from the name (no explicit `src:`).
- The project is pinned the canonical way: in the blueprint's `values`.

## Toolchain notes

- `blueprints *` commands are **not** offline, so they're treated as server-touching and are 
  **not** part of the build or the allowed local commands.
- The only local-only CLI helpers are `sanity functions dev` / `functions test` / `functions add`.
- `tsconfig.json` mirrors the canonical starter toolchain (`module: ESNext`, `moduleResolution: bundler`).

## Running

- Single eval (grader only; skips install + build):
  ```bash
  pnpm test-eval sanity-blueprints --model claude-opus-4-8 --runs 1
  ```
- Full suite for an experiment (all evals, not just this one):
  ```bash
  pnpm agent-eval claude-opus-4.8
  ```

## Not graded (deliberately deferred)

- **Behavioral correctness** of the function (does it actually set the slug). That needs executing
  the handler against a document — a live deploy+verify path that was explicitly deferred.
- **GROQ filter/projection correctness** beyond the event wiring being present.

These are intentional: the suite is static-only today, and we don't want to assert behavior we
can't yet exercise end-to-end.
