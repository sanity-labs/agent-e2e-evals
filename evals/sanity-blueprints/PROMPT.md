This is a minimal Sanity Blueprints workspace, already wired to a project (see `sanity.blueprint.ts`). I want a Sanity Function, declared in the blueprint, that runs when a `post` document is **published** and gives it a `slug` derived from its `title` whenever the slug is missing.

Two pieces of work:

1. Declare the function as a resource in the blueprint, triggered by the publish event on `post` documents.
2. Write the handler by hand in its own file. It should look at the published document and, only when `slug.current` is missing, derive a URL-friendly slug from `title` and patch it back onto the document.

Do all of this locally. I'll deploy it myself later. Please don't run any command that creates, changes, or reads server resources (for example the blueprints `init`, `plan`, `deploy`, `destroy`, `info`, `logs`, or `doctor` subcommands, or `functions env`). Local-only helpers like `sanity functions dev` or `sanity functions test` are fine.
