# sanity-migration eval

Can a coding agent write a Sanity content migration that changes data safely? The fixture is a small Studio whose `post` stores `body` as a Markdown string and `author` as a plain name. The agent is asked to convert both: Portable Text for the body, and references to deduplicated `author` documents for the author. It must also update the schema, and the migration must be safe to run twice (see [the prompt](../../evals/sanity-migration/PROMPT.md)).

**Grading runs the agent's migration offline.** [`EVAL.ts`](../../evals/sanity-migration/EVAL.ts):

- finds the migration with the Sanity CLI's own resolver, and expects exactly one;
- runs it with the public `dryRun` from `@sanity/migrate` on a hidden 13-document export, so the real document-type, filter, system-id and draft rules apply. Author ids only need to be valid Sanity document ids (checked with `@sanity/client`'s own validator); path ids such as `authors.x` are allowed, and posts may gain extra fields;
- applies each batch with `applyInCollection` from `@sanity/mutate`, which rejects a duplicate `create` or a patch on a missing document;
- runs a second pass, in a fresh process, on the first pass's output plus one new post by a known author;
- installs an in-process tripwire on Node's `net.Socket.connect` that refuses and counts connection attempts. The verifier itself has network, so this is what turns an ordinary fetch, Sanity client or http read into UNKNOWN. A migration that opens connections from a child process or Worker can bypass it.

It checks:

- block text, order, style, list kind and level, and exactly which characters carry bold, italic and each link (span splits and key values don't matter);
- one author per normalised name, with references that resolve;
- already converted fields are left alone, and every other field and document is preserved;
- the rerun changes nothing, and the new post reuses the existing author document;
- `sanity schema extract` shows a block-array body, an author reference and an `author` type with a `name`.

The grader runs the installed `tsc --noEmit` itself (`tsconfig.json` is a protected path), so editing the `build` script cannot skip the typecheck.

**Outcome is automatic.** A test message starting `UNKNOWN` means the grader couldn't observe the attempt and is not a model failure. That covers a broken runner import, a mutation form the grader can't apply, or any connection attempt that reaches the tripwire, which the prompt rules out, even if the migration catches it.

**Document reads (contract v2.1).** `context.filtered.getDocument` on any document the migration selects (the document itself or another post) is served from the export by the native dry run and is allowed: it works offline, which is what the prompt's rule protects. Not detected: a read of an unselected document whose failure the migration catches and ignores, a client call that fails before opening a connection (the placeholder API host is a closed, non-blocked local port, so an ordinary Sanity client read does reach the tripwire), and reading `data/sample.ndjson` from disk. An undetected read can still influence the mutations a migration returns. A pass means "passes the offline fixture contract", not a certified live migration.

**Limits:**

- The harness supplies only a synthetic export and placeholder configuration; this is not network isolation.
- Real write concurrency and transaction atomicity are not tested.
- The grader imports one internal path from `@sanity/cli` (the migration resolver). The verifier npm-installs from the caret ranges, so rerun calibration whenever the resolved versions change.
