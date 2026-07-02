import {defineBlueprint} from '@sanity/blueprints'

const PROJECT_ID = 'xg4e0byh'
const DATASET = 'production'

export default defineBlueprint({
  values: {
    projectId: PROJECT_ID,
    dataset: DATASET,
  },
  resources: [
    // TODO(blueprints-eval)
  ],
})
