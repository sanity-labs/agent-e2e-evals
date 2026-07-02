# sanity-blueprints eval

Can a coding agent add a Sanity Function to a Blueprint from a high-level request? Given a minimal Blueprints project, the agent is asked to make a `post`'s `slug` fill in from its `title` on publish (see `PROMPT.md`). A correct solution declares a document Function in the blueprint and writes its handler.

Grading is static: `EVAL.ts` reads the resulting files and never calls Sanity. It checks that the solution declares a document Function, wires it to the publish event, exports a handler, imports only real `@sanity/functions` symbols, preserves the pinned project and dataset, and keeps server-touching commands out of the auto-run `build`. An untouched fixture scores 4/8; a correct solution scores 8/8.

Behavioral correctness (whether the slug actually gets set) is not graded; that would need a live deploy, which is out of scope for this static suite.
