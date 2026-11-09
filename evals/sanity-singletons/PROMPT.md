Editors need three fixed documents in this Studio. The website reads them by these exact IDs.

- Site settings: one `siteSettings` document with the ID `siteSettings`. Editors open it straight from the sidebar. They must not be able to create another site settings document or duplicate this one.
- Campaigns: two fixed `campaign` documents, "Spring campaign" (ID `springCampaign`) and "Summer campaign" (ID `summerCampaign`). Editors open each one straight from the sidebar. When an editor opens one for the first time, its `season` field already says `spring` or `summer`. Editors must still be able to create and browse ordinary one-off campaigns, as they do now.
- Keep the rest of the sidebar working: editors still find and create posts, authors and pages.

Example content is in `data/sample.ndjson`. Make sure `tsc --noEmit` passes and `sanity schema extract` works. Everything you need is installed: don't add or change dependencies, and don't change `tsconfig.json`. You don't need to deploy, run the Studio or connect to a dataset.
