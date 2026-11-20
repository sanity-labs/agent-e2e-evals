Editors write two kinds of text on blog posts, and the editor should give them exactly the tools each one needs and nothing more. Add an `excerpt` field to `post` and rework its existing `body` field. The website's code reads these names, so keep them exactly.

- The excerpt is a short teaser: plain paragraphs where editors can make text bold or italic. Nothing else: no headings, lists, links or other formatting, and no images or other embeds.
- The body is the article: paragraphs, H2 and H3 headings, bulleted and numbered lists, bold, italic and inline code, links and images. The website renders links from a `link` annotation with the URL in `href`, and only https and mailto links are allowed. Images use the `image` type and always need `alt` text. Nothing else.

There's example content in `data/sample.ndjson`. We can't add or upgrade dependencies or change `tsconfig.json` right now, and there's no dataset to connect to or deploy for this: we just need the code ready.
