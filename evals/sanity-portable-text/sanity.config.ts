import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes'

export default defineConfig({
  name: 'default',
  title: 'Acme website',
  projectId: 'xg4e0byh',
  dataset: 'production',
  plugins: [structureTool()],
  schema: {types: schemaTypes},
})
