# Contributing

This guide covers the local workflow for adding in new models/harnesses, updating the eval suite, and working with results.
It's primarily intended for Sanity team members, but external contributions are more than welcome!

## Project information

We use the [@vercel/agent-eval framework](https://github.com/vercel-labs/agent-eval) to define & run our evals.

Here's some terminology you'll see used throughout @vercel/agent-eval and this project:

- Model - the LLM that's using the agent harness (ex. Composer 2.5)
- Harness - the wrapper around the raw model which exposes tools, prompting, etc. for performing tasks (ex. Cursor, Claude Code)
- Agent - the combination of a model and harness (ex. Codex + GPT-5.5)
- Eval - a task we give an agent to measure overall coding capability
  - Each eval includes a prompt, a test suite for grading, and any additional project files to use in the task
  - These live in `./evals/`
- Experiment - the configuration used when we run our eval suite
  - These live in `./experiments/` and include the harness, model, and other parameters for actually running the evals
  - We define a separate experiment for each variant (one of baseline, MCP, or skills) which are then grouped together in the results summary
- Results - the raw outputs from @vercel/agent-eval of each experiment which can be used to determine how well each experiment performed on the evals
  - When you run `agent-eval`, results are stored in `./results/` locally
  - Browse these with `pnpm playground`, which launches a local web UI for inspecting runs, transcripts, and side-by-side comparisons
- Results summary - a JSON representation of the eval results, the format itself is defined in `./published/` and `scripts/export-results.ts`

## Dev tools

To setup the repo for local development, run these commands:

1. Ensure [mise-config](https://github.com/sanity-io/mise-config) has been set up
2. Install 1Password and get access to the "Dev Secrets" vault
   - This isn't required to run evals, but `fnox` will be very sad since it can't access the secrets in 1Password
3. Clone the repo and run `mise trust` + `mise install`
4. Cache the secrets from fnox `fnox sync --provider age --local-file`
   - This exports the secrets from 1Password and encrypts them locally, not required but makes it so you aren't prompted by 1Password continuously
5. Run `pnpm install`

## Running scripts

Scripts are mostly defined in package.json and meant to be run via pnpm, but we try to keep parity with mise.

You can use `pnpm run` or `mise tasks` to get a list of scripts to run.

### Running evals

If you're working on one eval you can use `pnpm test-eval` to run a single eval specifically, rather than running the whole suite.
Use `pnpm test-eval --help` to see the options for the script.

To run the full eval suite, use the `agent-eval` CLI directly.
You can run evals via GitHub Actions by [triggering the workflow to run manually](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), see `.github/workflows/evals.yml` for more info.

### Browsing results

Use `pnpm playground` (or `pnpm playground:watch`) to browse eval outputs in `./results` in a local web UI.
This is a good tool when iterating on evals locally and trying to understand why an assertion is failing, what tools an agent is using, etc.

Use `pnpm export-results` to generate our results summary JSON (see [`published/README.md`](published/README.md)).
You can also review the raw result files directly in `./results/`.
