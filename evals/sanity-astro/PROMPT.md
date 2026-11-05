Our Astro site should show the blog posts our editors write in Sanity (project `abc123`, dataset `production`; the Studio's post and author types are in `studio-schema/`).

- Add a list of posts at `/posts/`, newest first, each linking to the post's page at `/posts/<slug>/`.
- A post page shows the title, the author's name, the publish date in a `<time datetime="…">` element with a readable label, the body as formatted text (bold, italic and links work), and the main image with its alt text.
- Posts without a slug don't appear.

The site is built statically and shows published content only; draft previews are out of scope. Show images from Sanity's image CDN; don't download or optimise them at build time.

`npm run build` builds the site against a local copy of the content API with the example content in `data/sample.ndjson`, so no live project or credentials are needed. Make sure it passes. Everything you need is installed: don't add or change dependencies, and don't change `tsconfig.json` or `scripts/`.
