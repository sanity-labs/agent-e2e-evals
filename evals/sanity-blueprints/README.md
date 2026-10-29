# sanity-blueprints eval

Can a coding agent add a Sanity Function to a Blueprint from a high-level request? Given a minimal Blueprints project, the agent is asked to make a `post`'s `slug` fill in from its `title` on publish (see `PROMPT.md`).

**Grading observes behaviour, offline, with a fake token.** `EVAL.ts` loads the agent's blueprint with the Sanity CLI's own loader, then runs the function through the CLI's local runner (`sanity-run functions test`) on five publish events:

- **A:** a new post with no slug
- **B:** a post that already has a slug
- **C:** an author document
- **D:** A's result published again
- **E:** an existing slugless post republished

The runner applies the blueprint's own filter and projection. The function's writes go to a loopback stand-in for the fixture project's dataset and are applied with `@sanity/mutator`. The tests check the resulting documents.

**Outcomes are manual.** The exporter keeps this task unknown until a person labels the attempt, using these observations. A test message starting `UNKNOWN` means the grader could not observe the case: an unsupported request, a target other than the fixture project, an outside hostname, more than one function, or the CLI loader failing. It is not evidence the model failed.

**Limits:**
- Nothing is deployed. Real event delivery and token permissions are not tested.
- The DNS stub routes every hostname to loopback but doesn't isolate the network, so calibrate inside `unshare -rn`.
- The grader imports one internal path from `@sanity/runtime-cli` 17.0.0 (pinned by the lockfile). Rerun calibration when the lockfile changes.

Calibration and design: `research/function-handler-grader-v2.md` and the calibration write-up.
