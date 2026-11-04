# sanity-schema eval

Can a coding agent model content in a Sanity Studio so editors get the rules they need? The fixture is a small Studio with `post` and `author` types. The agent adds a `page` type with a slug, a navigation flag and label, and a list of sections (`hero`, `richText`, `postList`), plus the editor rules the prompt lists (see [the prompt](../../evals/sanity-schema/PROMPT.md)). Task version 1.

**Grading is offline.** [`EVAL.ts`](../../evals/sanity-schema/EVAL.ts):

- runs `tsc --noEmit` and `sanity schema extract` (`tsconfig.json`, `package.json`, `npm-shrinkwrap.json` and `.npmrc` are protected paths);
- loads the schema the Studio actually uses through `sanity.config.ts` (jiti) and `sanity.resolveSchemaTypes`, compiles it with `sanity.createSchema`, and checks that every field the frontend reads exists with the right kind, and that `postList.posts` references only `post`;
- validates hidden pairs of documents for each rule (one valid, one or two invalid) with Sanity's own validation in Studio mode, against a local GROQ corpus. A rule passes when the valid document has no error and each invalid one has an error. For a duplicate slug, a warning the valid page doesn't get also counts;
- checks three valid controls: no nav label when the page isn't in navigation, a hero without an image, and a draft of a published page keeping its own slug (fails on an error or on the duplicate test's own warning).

A test message starting `UNKNOWN` means the grader couldn't observe the attempt (for example, a validator asked the client for something other than a GROQ fetch), not that the agent failed.

**Limits. Read these before upgrading Sanity or reusing the scores:**

- **Cooperative eval, not tamper-proof.** The grader runs the agent's own `sanity.config.ts` in the process that checks the schema, so an agent could write its own result. A calibration answer that does this scores full marks. Every attempt's changed files and transcript are reviewed by hand; an attempt that interferes with grading or dependencies is reported INVALID, with its automatic score beside it.
- **Pinned internal API.** Validation uses `evaluateDocumentInternal` from `@sanity/validation/_internal`, because the public `validateDocument` runs in CLI mode, which turns custom document-level `.error()` rules into warnings. It is pinned at `sanity` 6.22.0 by the fixture's shrinkwrap. **Before upgrading Sanity in this fixture, check that this internal function and its Studio-mode behaviour still exist, then rerun the calibration set.**
- Every run records `npm-shrinkwrap.json` as tampering, because npm prunes 27 entries marked extraneous in the committed file. That exact change is benign; any other change to the lockfile needs a look.
- Drafts still save; a pass means content is validated before publishing in this offline check. The Studio UI is not run.
