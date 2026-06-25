import {defineBlueprint} from '@sanity/blueprints'

const PROJECT_ID = 'xg4e0byh'
const DATASET = 'production'

export default defineBlueprint({
  values: {
    projectId: PROJECT_ID,
    dataset: DATASET,
  },
  resources: [
    // TODO(blueprints-eval): declare the Sanity document Function described in
    // PROMPT.md and wire it to the document event.
    //
    // Scaffold everything locally. Do not run any CLI subcommand that creates,
    // changes, or reads server resources (e.g. blueprints init/plan/deploy).
  ],
})
