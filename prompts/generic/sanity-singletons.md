Editors need three fixed documents in this Studio, and the website looks them up by these exact IDs.

- Site settings: one `siteSettings` document with the ID `siteSettings`. Editors open it straight from the sidebar, and there is only ever one: they can't create another or duplicate it.
- Two seasonal campaigns, both `campaign` documents: "Spring campaign" (ID `springCampaign`) and "Summer campaign" (ID `summerCampaign`), each opened straight from the sidebar. The first time an editor opens one, its `season` field already says `spring` or `summer`. Editors still create and browse their other, one-off campaigns as they do today.
- Everything else in the sidebar keeps working: editors still find and create posts, authors and pages.

There's example content in `data/sample.ndjson`. We can't add or upgrade dependencies or change `tsconfig.json` right now, and there's no dataset to connect to or deploy for this: we just need the code ready.
