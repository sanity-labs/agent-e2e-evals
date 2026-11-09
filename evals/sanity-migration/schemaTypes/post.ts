import {defineField, defineType} from 'sanity'

export const post = defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}}),
    defineField({name: 'publishedAt', type: 'datetime'}),
    defineField({name: 'body', title: 'Body (Markdown)', type: 'text'}),
    defineField({name: 'author', title: 'Author name', type: 'string'}),
    defineField({name: 'related', title: 'Related post slugs', type: 'array', of: [{type: 'string'}]}),
  ],
})
