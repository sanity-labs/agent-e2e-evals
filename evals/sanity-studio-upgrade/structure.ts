import type {StructureResolver} from 'sanity/structure'

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Content')
    .items([S.documentTypeListItem('post').title('Posts'), S.documentTypeListItem('author').title('Authors')])
