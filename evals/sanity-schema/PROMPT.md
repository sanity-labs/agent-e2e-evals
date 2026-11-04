Our website needs landing pages in English and Norwegian. Add a `page` document type to this Sanity Studio, and make sure the Studio uses it. The frontend already reads these names, so keep them exactly:

- `title` (text), `slug` (a URL slug), `language` (`en` or `nb`), `showInNav` (yes/no), `navLabel` (text), and `sections`, a list of blocks. Each block is one of:
  - `hero`, with a `heading` and an optional `image` that has `alt` text;
  - `richText`, with a `body` of rich text;
  - `postList`, with `posts`, a list of links to posts.
- Every block also has an optional `visibleFrom` and `visibleUntil` (date and time), so editors can schedule it.

Editors should get a validation error before they can publish when:

- a page has no title, no slug, no language or no sections, or its language isn't `en` or `nb`;
- a page is shown in the navigation but has no nav label (pages that aren't in the navigation don't need one);
- a page has more than one hero, or a hero that isn't the first block (pages without a hero are fine);
- a hero has no heading, or has an image without alt text (a hero without an image is fine);
- a rich text block has an empty body. A body is empty when none of its paragraphs contains any text other than whitespace (spaces, tabs and line breaks); a blank paragraph next to a paragraph with text is fine;
- a post list has no posts, or links to the same post more than once (the same post can appear in different lists);
- a block has both `visibleFrom` and `visibleUntil`, and `visibleUntil` isn't later in time than `visibleFrom` (either one on its own is fine).

Editors should also be warned, or stopped, when a page uses a slug that another page in the same language already has. The same slug in another language is fine, A slug that another page in the same language holds only in an unpublished draft counts as taken too. A page's own draft and published copies don't count as duplicates of each other. A post list may only link to posts.

Example content is in `data/sample.ndjson`. Make sure `tsc --noEmit` passes and `sanity schema extract` works. Everything you need is installed: don't add or change dependencies, and don't change `tsconfig.json`. You don't need to deploy, run the Studio or connect to a dataset.
