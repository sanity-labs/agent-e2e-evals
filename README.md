# Sanity E2E Agent Evals Suite

This repository contains Sanity's E2E eval suite we use to benchmark coding agents on how well they accomplish realistic tasks on Sanity projects.

We test several different agent harnesses (Claude Code, Codex, Cursor, etc.) with a variety of models to better understand their strengths & weaknesses when working with Sanity.
Evals are split into three categories:

- Baseline - a stock coding agent config
- MCP - the agent has access to [the Sanity MCP server](https://www.sanity.io/docs/ai/mcp-server)
- Skills - the agent is configured with [Sanity's agent skills](https://github.com/sanity-io/agent-toolkit#readme)

This lets us quantify how much our MCP and agent skills help agents.

For local development, running scripts, and working with generated results, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How the suite works

Each eval is a realistic Sanity-related coding task in a project fixture.
The agent receives the prompt, works in the fixture, and then static assertions are run to determine how well the agent completed the task.

We grade evals on two main things:

- The fixture's own build/test scripts, which catch runtime, type, and integration problems
- The eval's Vitest assertions (`EVAL.ts`), which check whether the agent delivered the intended outcome

## Experiment methodology

We run the same eval suite across the baseline, MCP, and skills variants for each agent.
This keeps the task set consistent so differences in scores reflect the available tools and prompting rather than differences in the evals themselves.

Agent behavior is nondeterministic, so our experiment configs use scores averaged across multiple runs to de-noise the results we get.

Scores are based on assertion pass ratios.
For a single run, the score is `passed tests / total tests` from the eval's Vitest output.
Those run scores are averaged across attempts, then across evals, then across variants for summary views.
See [`published/README.md`](published/README.md) for more info on the exported JSON summary format.

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
