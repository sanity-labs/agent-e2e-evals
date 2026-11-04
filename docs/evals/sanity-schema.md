# sanity-schema eval

Can a coding agent model content in a Sanity Studio so editors get the rules they need? The fixture is a small Studio with `post` and `author` types. The agent adds a `page` type with a slug, a navigation flag and label, and a list of sections (`hero`, `richText`, `postList`), plus the editor rules the prompt lists (see [the prompt](../../evals/sanity-schema/PROMPT.md)). Task version 2: v1 plus a page language (en or nb), slugs unique per language with drafts counting as taken, at most one hero and only first, rich text that counts blank paragraphs as empty, no repeated post in a list, and optional start/end dates in order. Results from v1 and v2 are never pooled.

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

**Notes for v2 results:**

- A custom slug query that asks for the `drafts` perspective gets UNKNOWN; only raw and published are simulated. Duplicate-slug grading compares warnings within a bound and is not a semantic uniqueness proof.
- The date twins include an offset time equal to a UTC time. Comparing ISO strings as text fails it. Studio's date-time input always writes UTC, so offset values arrive only through the API, imports or migrations.
- v2 attempts took 10 to 30 minutes in the Haiku pilot, so the 30-minute limit is part of what is measured.
