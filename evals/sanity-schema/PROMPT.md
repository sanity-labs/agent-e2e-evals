Our website needs landing pages. Add a `page` document type to this Sanity Studio, and make sure the Studio uses it. The frontend already reads these names, so keep them exactly:

- `title` (text), `slug` (a URL slug), `showInNav` (yes/no), `navLabel` (text), and `sections`, a list of blocks. Each block is one of:
  - `hero`, with a `heading` and an optional `image` that has `alt` text;
  - `richText`, with a `body` of rich text;
  - `postList`, with `posts`, a list of links to posts.

Editors should get a validation error before they can publish when:

- a page has no title, no slug, or no sections;
- a page is shown in the navigation but has no nav label (pages that aren't in the navigation don't need one);
- a hero has no heading, or has an image without alt text (a hero without an image is fine);
- a rich text block has an empty body;
- a post list has no posts.

Editors should also be warned, or stopped, when a page uses a slug that another page already has. A post list may only link to posts.

Example content is in `data/sample.ndjson`. Make sure `tsc --noEmit` passes and `sanity schema extract` works. You don't need to deploy, run the Studio or connect to a dataset.
