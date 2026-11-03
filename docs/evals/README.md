# How each eval is graded

These notes live outside the fixture folders so the harness does not supply them to agents. README files inside a fixture are supplied and can expose grading details.

- [sanity-blueprints](sanity-blueprints.md)
- [sanity-migration](sanity-migration.md)

## Fixture lockfiles

A fixture pins its starting dependencies with `npm-shrinkwrap.json`, not `package-lock.json`. agent-eval 2.6.0 leaves `package-lock.json` and `pnpm-lock.yaml` out of the files it uploads to the sandbox (`IGNORED_PATTERNS` in its `sandbox.js`), so a package-lock would never reach the pre-agent `npm install`. npm reads `npm-shrinkwrap.json` the same way in a private root project. The agent can still upgrade, and its own `npm install` rewrites the file. The Studio upgrade fixture added this on 3 Nov after an upstream publish broke the unpinned starting install.
