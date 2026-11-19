import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'
import {structure} from './structure'

export default defineConfig({
  name: 'default',
  title: 'Acme Blog',
  projectId: 'abc12345',
  dataset: 'production',
  plugins: [structureTool({structure}), visionTool()],
  schema: {types: schemaTypes},
  search: {enableLegacySearch: true},
  auth: {
    mode: 'append',
    redirectOnSingle: false,
    providers: [{name: 'saml', title: 'Acme SSO', url: 'https://sso.acme.example/login'}],
  },
})
