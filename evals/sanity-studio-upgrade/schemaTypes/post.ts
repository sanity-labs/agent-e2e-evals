import {defineArrayMember, defineField, defineType} from 'sanity'
import {TitleInput} from '../components/TitleInput'

export const post = defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', components: {input: TitleInput}, validation: (rule) => rule.required()}),
    defineField({name: 'slug', type: 'slug', options: {source: 'title'}}),
    defineField({name: 'author', type: 'reference', to: [{type: 'author'}]}),
    defineField({name: 'publishedAt', type: 'datetime'}),
    defineField({
      name: 'body',
      type: 'array',
      of: [defineArrayMember({type: 'block'}), defineArrayMember({type: 'image', options: {hotspot: true}})],
    }),
  ],
})
