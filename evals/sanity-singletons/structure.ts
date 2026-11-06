import type {StructureResolver} from 'sanity/structure'

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Content')
    .items([
      S.listItem()
        .title('Blog')
        .child(S.list().title('Blog').items([S.documentTypeListItem('post'), S.documentTypeListItem('author')])),
      S.documentTypeListItem('page'),
      S.divider(),
      S.documentTypeListItem('campaign'),
      S.documentTypeListItem('siteSettings'),
    ])
