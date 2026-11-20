We're launching landing pages in English and Norwegian, and editors will build them in this Studio. Add a `page` document type and make it available in the Studio. Our website's code is already written against these names, so please use them exactly:

- `title` (text), `slug` (a URL slug), `language` (`en` or `nb`), `showInNav` (yes/no), `navLabel` (text), and `sections`, a list of blocks. Each block is one of:
  - `hero`: a `heading` and an optional `image` with `alt` text;
  - `richText`: a `body` of rich text;
  - `postList`: `posts`, a list of links to posts.
- Editors can schedule any block with an optional `visibleFrom` and `visibleUntil` (date and time).

Editors shouldn't be able to publish a page that would break the site: a page with no title, slug or language, or with no sections, or with a language other than `en` or `nb`; a page shown in the navigation without a nav label; a page with more than one hero, or a hero that isn't the first block; a hero without a heading, or with an image that has no alt text; a rich text block with no real text in it (spaces, tabs and blank lines don't count); a post list with no posts, or with the same post twice; or a block whose `visibleUntil` isn't later than its `visibleFrom`. These are fine: a page that isn't in the navigation and has no nav label, a page without a hero, a hero without an image, a blank paragraph next to one with text, the same post in two different lists, and a block with only one of the two dates.

A page's slug is its URL within its language, so editors should at least be warned when another page in the same language already uses it, even if that page is only an unpublished draft. The same slug in English and Norwegian is fine, and a page's draft doesn't clash with its own published version. Post lists should only link to posts.

There's example content in `data/sample.ndjson`. We can't add or upgrade dependencies or change `tsconfig.json` right now, and there's no dataset to connect to or deploy for this: we just need the code ready.
