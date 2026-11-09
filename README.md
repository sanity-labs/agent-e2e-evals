# Sanity E2E Agent Evals Suite

This repository contains Sanity's E2E eval suite we use to benchmark coding agents on how well they accomplish realistic tasks on Sanity projects.

We test a variety of models to better understand their strengths & weaknesses when working with Sanity. (Earlier versions of this suite also compared harnesses such as Claude Code, Codex and Cursor.)
Each model runs in the same harness through OpenRouter, in two variants:

- Baseline - a stock coding agent config
- Skills - the agent is configured with [Sanity's agent skills](https://github.com/sanity-io/agent-toolkit#readme)

This lets us measure how much our agent skills help. The earlier MCP variant is not part of the current runner.

For local development, running scripts, and working with generated results, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How the suite works

Each eval is a realistic Sanity-related coding task in a project fixture.
The agent receives the prompt, works in the fixture, and then static assertions are run to determine how well the agent completed the task.

Graders run separately from the agent. Several use local stand-ins for the Sanity query API and hidden test data, including fixed cases. We audit transcripts and changed files; public graders can be learned, so a task that leaks needs a new version. A few evals have the agent interact with live Sanity resources on our staging instance.
See [CONTRIBUTING.md](CONTRIBUTING.md#working-with-real-sanity-projects) for guidance on how to work with these evals.

We grade evals on two main things:

- The fixture's own build/test scripts, which catch runtime, type, and integration problems
- The eval's Vitest assertions (`EVAL.ts`), which check whether the agent delivered the intended outcome

## Experiment methodology

We run the same eval suite across the baseline and skills variants for each model.
This keeps the task set consistent so differences in scores reflect the available tools and prompting rather than differences in the evals themselves.

Agent behavior is nondeterministic, so we repeat each model and task several times in fresh sandboxes and report raw counts, not one run.

An attempt passes only if the project's scripts and every check in its `EVAL.ts` pass. We report, for each model and task, the number of attempts, passes, infrastructure failures (counted separately, never as agent failures), cost, tokens and time. We do not report a single blended score. The starter, presentation, live-content and Functions (blueprints) evals give a label-only outcome: it stays unknown until someone labels it. The July results in [`published/`](published/README.md) came from the previous runner and used its pass-ratio scoring.

## What evals should measure

Evals should measure whether an agent can complete realistic Sanity development work.
They should not reward memorizing exact patches or following overly-specific instructions that a real developer would not receive.

A good eval usually starts from an intentionally incomplete or broken fixture, then asks for a user-visible product or developer workflow improvement.
The grading should focus on whether that outcome works:

- Can the project still build?
- Are Sanity-specific APIs wired correctly? Do they use current best practices?
- Did the agent preserve the existing app conventions?
- Did the agent avoid hard-coded shortcuts that only satisfy one fixture state?

Prefer tasks with a clear success state but potentially multiple valid solutions.
That gives agents room to exercise their problem solving & reasoning ability, which is a better representation of utility to a real developer.

## Writing eval prompts

Each eval gets a `PROMPT.md` file, which is provided to the agent when running the eval.

Keep prompts fairly simple and open-ended, these should feel like something you'd actually ask a coding agent to do.
Avoid hand-holding the agent to use a specific feature or tell it what files to edit.
Focus more on high-level outcomes vs technical details.

## Writing eval assertions

We use static assertions in `EVAL.ts` files to score evals. These are written with Vitest and run after the agent has finished its task.

Writing static checks can be a little tricky since agents never write the exact same code, but doing things this way keeps assertions fast and consistent.
It'll likely take a bit of iteration before you get a test suite that reliably works.
Typically you start off with tests that are excessively strict, which fail when a slightly different (but valid) solution is graded.

Since coding agents are fairly capable now, we generally assume that they are writing (mostly) valid code.
If the `build` script passes, checking for a few key changes is usually a good enough heuristic that the agent successfully completed the task.

## Fixture design

Don't be afraid to create large fixtures, these are often most representative of real-world projects!
Using template/example projects from the Sanity documentation and community is a good way to get something set up quickly.

Fixtures should define a package.json with a `build` script, this will be used as part of the grading process when running evals.

## Additional resources

Evals are a new problem that we as an industry are learning how to solve, but there are emerging patterns + best practices.
Take a look at these other eval projects and their methodology to help guide your own changes to our suite:

- <https://senior-swe-bench.snorkel.ai/blog/2026-06-16-how-it-works#task-design>
- <https://deepswe.datacurve.ai/blog/deepswe#task-construction>
