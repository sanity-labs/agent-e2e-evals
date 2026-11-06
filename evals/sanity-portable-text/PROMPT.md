Add an `excerpt` field to `post` and change its existing `body` field. The frontend reads these names, so keep them exactly.

- `excerpt`: rich text with plain paragraphs only. Editors can make text bold or italic, and nothing else: no headings, no lists, no links, no other formatting, and no images or other embedded content.
- `body`: rich text with paragraphs, H2 and H3 headings, bulleted and numbered lists, bold, italic and inline code. Editors can add links as a `link` annotation with the URL in `href`; the URL must use the https or mailto scheme. Editors can also add images (type `image`), and every image needs `alt` text. Nothing else.

The editor should offer only these options. Example content is in `data/sample.ndjson`. Make sure `tsc --noEmit` passes and `sanity schema extract` works. Everything you need is installed: don't add or change dependencies, and don't change `tsconfig.json`. You don't need to deploy, run the Studio or connect to a dataset.
