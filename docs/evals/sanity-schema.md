# sanity-schema eval

Can a coding agent model content in a Sanity Studio so editors get the rules they need? The fixture is a small Studio with `post` and `author` types. The agent adds a `page` type with a slug, a navigation flag and label, and a list of sections (`hero`, `richText`, `postList`), plus the editor rules the prompt lists (see [the prompt](../../evals/sanity-schema/PROMPT.md)). The rules include a page language (en or nb), slugs unique per language with drafts counting as taken, at most one hero and only first, rich text that counts blank paragraphs as empty, no repeated post in a list, and optional start/end dates in order.

**Grading is offline.** [`EVAL.ts`](../../evals/sanity-schema/EVAL.ts):

- runs `tsc --noEmit` and `sanity schema extract` (`tsconfig.json`, `package.json`, `npm-shrinkwrap.json` and `.npmrc` are protected paths);
- loads the schema the Studio actually uses through `sanity.config.ts` (jiti) and `sanity.resolveSchemaTypes`, compiles it with `sanity.createSchema`, and checks that every field the frontend reads exists with the right kind, and that `postList.posts` references only `post`;
- validates hidden documents with Sanity's own validation in Studio mode, against a local GROQ corpus: one valid page, which must have no error before any rule is checked, and for each of 13 rules one or more invalid variants of it. A rule passes when every invalid variant has an error. For a duplicate slug, a warning the valid page doesn't get also counts;
- checks eight groups of valid controls, each failing on an error (the slug controls also fail on the duplicate test's own warning): no nav label when the page isn't in navigation; a hero without an image; a draft of a published page keeping its own slug; the same slug in another language; a page without a hero; a post in two lists and a list with different posts; a blank paragraph next to text; a block with one date, or both in order.

A test message starting `UNKNOWN` means the grader couldn't observe the attempt (for example, a validator asked the client for something other than a GROQ fetch), not that the agent failed.

**Limits. Read these before upgrading Sanity or reusing the scores:**

- **Cooperative eval, not tamper-proof.** The grader runs the agent's own `sanity.config.ts` in the process that checks the schema, so an agent could write its own result. A calibration answer that does this scores full marks. Every attempt's changed files and transcript are reviewed by hand; an attempt that interferes with grading or dependencies is reported INVALID, with its automatic score beside it.
- **Pinned internal API.** Validation uses `evaluateDocumentInternal` from `@sanity/validation/_internal`, because the public `validateDocument` runs in CLI mode, which turns custom document-level `.error()` rules into warnings. It is pinned at `sanity` 6.22.0 by the fixture's shrinkwrap. **Before upgrading Sanity in this fixture, check that this internal function and its Studio-mode behaviour still exist, then rerun the calibration set.**
- Every run records `npm-shrinkwrap.json` as tampering, because npm prunes 27 entries marked extraneous in the committed file. That exact change is benign; any other change to the lockfile needs a look.
- Drafts still save; a pass means content is validated before publishing in this offline check. The Studio UI is not run.

**Notes on results:**

- A custom slug query that asks for the `drafts` perspective gets UNKNOWN; only raw and published are simulated. Duplicate-slug grading compares warnings within a bound and is not a semantic uniqueness proof.
- The date twins include an offset time equal to a UTC time. Comparing ISO strings as text fails it. The standard datetime input serializes new selections to UTC. The task also accepts offset-form values, so its date rules compare instants.
- Attempts can take 10 to 30 minutes, so the 30-minute limit is part of what is measured.

**Prompt versions.** Every attempt records the SHA-256 of the prompt it was given, so results from different versions are never pooled.

- `0536d4a9…` (until November 2026): stated the rules as a validation list and told the agent to make sure `tsc --noEmit` passes and `sanity schema extract` works.
- `e47b2228…` (current): the same names, rules and controls, asked the way a user would, with no tooling instructions ([AIGRO-5685](https://linear.app/sanity/issue/AIGRO-5685/make-eval-prompts-less-specific)). In a side-by-side on 20 November 2026 (5 attempts per prompt on Claude Code with Haiku 5.5 and Sonnet 5.5, and Codex with GPT-5.6 Terra), agents given the new prompt still ran the type check 15/15 and schema extract 14/15, and the build check passed 15/15. Full passes were 7/15 against 9/15 with the old prompt: one fewer for Haiku and Sonnet, equal for GPT. Every failure in both arms missed the same-slug-in-another-language control. The generic prompt was within one pass in every lane, which is no large gap at 5 attempts per cell, so it met the rule set before the run ([PR 82](https://github.com/sanity-labs/agent-e2e-evals/pull/82)).

The slug-hint experiment (`experiments/gpt-5.6-terra-slug-hint.ts`) appends its hint to whichever prompt is current, so hint runs on the new prompt are not comparable with the November 2026 hint result, which used the old one.
