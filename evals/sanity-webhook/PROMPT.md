The blog's pages are cached. When an editor publishes or changes a post, Sanity will POST to `/api/revalidate` with the body `{"_type":"post","slug":"<slug>"}`, signed with the secret in the `SANITY_REVALIDATE_SECRET` environment variable using Sanity's standard webhook signature. Make the posts list and that post's page show the new content after such a request. Requests that aren't from Sanity must not change anything. Preserve the existing cached reads. `npm run build` must pass.

`app/api/sample-witness` and `scripts/sample-api.mjs` are test set-up; leave them alone.
