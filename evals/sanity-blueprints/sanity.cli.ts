import {defineCliConfig} from 'sanity/cli'

// Pinned eval target. Keep these IDs in sync with EVAL.ts
// (PINNED_PROJECT_ID / PINNED_DATASET). The agent must not change them.
export default defineCliConfig({
  api: {
    projectId: 'FILL_IN_PROJECT_ID',
    dataset: 'FILL_IN_DATASET',
  },
})
