This project pages through Sanity `post` documents with GROQ, using a cursor. In `src/pagination.ts`, implement `firstPage()` and `nextPage(cursor)`. Each returns `{query, params}`: a GROQ query and its parameters, which are run against the dataset as it is at that moment.

Each query returns the next 5 posts (fewer only at the end, and an empty array when there are none left), each as `{_id, title, publishedAt}`. Order: newest `publishedAt` first; posts with the same `publishedAt` by `_id`, descending; posts without a `publishedAt` after all dated posts, by `_id`, descending. Only `post` documents count. Every `publishedAt` is a UTC timestamp in the same format, for example `2026-03-01T09:00:00Z`.

`cursor` is the last post of the previous page, `{_id, publishedAt}`, where `publishedAt` is `null` if that post has none. Between pages, posts may be created or deleted (including posts already returned, and the cursor post itself), but no post's `_id` or `publishedAt` ever changes. A walk must never repeat a post, and must return every post that still exists and sorts after the cursor. A post created ahead of the cursor is not expected in that walk.

Put all of your code in `src/pagination.ts`; it must not import anything. `data/sample.ndjson` has sample documents, and `groq-js` is installed if you want to try your queries.
