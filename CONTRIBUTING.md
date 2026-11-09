# Contributing

This guide covers the local workflow for adding in new models/harnesses, updating the eval suite, and working with results.
It's primarily intended for Sanity team members, but external contributions are more than welcome!

## Project information

We use the [@vercel/agent-eval framework](https://github.com/vercel-labs/agent-eval) to define & run our evals.

Here's some terminology you'll see used throughout @vercel/agent-eval and this project:

- Model - the LLM that's using the agent harness (ex. Claude Haiku 5.5)
- Harness - the wrapper around the raw model which exposes tools, prompting, etc. for performing tasks (we use OpenCode for every model)
- Agent - the combination of a model and harness (ex. OpenCode + GPT-5.6 Terra)
- Eval - a task we give an agent to measure overall coding capability
  - Each eval includes a prompt, a test suite for grading, and any additional project files to use in the task
  - These live in `./evals/`
- Experiment - the configuration used when we run our eval suite
  - These live in `./experiments/` and include the harness, model, and other parameters for actually running the evals
  - We define a separate experiment for each variant (baseline or skills)
- Results - the raw outputs from @vercel/agent-eval of each experiment which can be used to determine how well each experiment performed on the evals
  - Each batch is stored in `./results/<runId>/` locally
- Results summary - a JSON representation of the eval results, the format itself is defined in `./published/` and `scripts/export-results.ts`

## Dev tools

1. Install [mise](https://mise.jdx.dev/), then clone the repo and run `mise trust` + `mise install` (Node 24, pnpm 11)
2. Run `pnpm install`
3. Before opening a PR, run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm knip` and `pnpm format` (CI runs the same checks)

## Working with real Sanity projects

Most evals never call Sanity: their graders serve hidden content from a local stand-in for the query API, created fresh for each run. A few live tasks (the getting-started scaffold) create real projects on the Sanity staging instance, authenticated with the `SANITY_AUTH_TOKEN` staging token.

The runner never deletes projects. Before and after each batch it saves the list of staging projects the token can see, and names the ones first seen during the batch, for someone to review and delete by hand. With a shared token and other work going on, "first seen during the batch" does not prove the batch created them.

Prefer evals that don't need Sanity APIs.

## Running evals

Every model runs in the same harness (OpenCode) through OpenRouter, so the model is the main thing that changes between experiments. Experiments live in `experiments/`: one file per model, plus variants such as `-skills`, which installs Sanity's agent skills.

Run a batch with `scripts/run.ts`:

```sh
node scripts/run.ts --key-file ~/.openrouter-key --evals sanity-typegen --runs 3 --concurrency 2 --cap 5 experiments/claude-haiku-5.5.ts
```

- `--key-file` is a file holding an OpenRouter key. The key is in the agent's environment, so use a separate key with a spend limit for each batch.
- `--cap` is a spend threshold for the whole batch in USD. The runner checks OpenRouter usage before each attempt starts and starts no new attempts past the cap. Attempts already running finish, so the final total can exceed it. `--attempt-stop` adds a per-attempt threshold, checked the same way.
- Everything for one batch is written to `results/<runId>/`, including a single `manifest.json` that records the experiments, prompt hashes, every attempt and its cost.

Smoke-test on one eval and one cheap model before a larger batch.

## Results

Summarise a batch with `node scripts/export-results.ts results/<runId> [report.json]`. It prints one row per model and task: attempts planned, saved and completed, passes, infrastructure failures, cost, tokens and time. There is no ranking.

An attempt passes only if the project's configured scripts and every check in the eval's `EVAL.ts` pass. Infrastructure failures (rate limits, sandbox faults) are never guessed. Mark one by writing the evidence in `results/<runId>/labels.json`. A few older evals only check structure, so their outcome stays unknown until someone labels it. The July results in `published/` were produced by the previous runner and use its scoring.
