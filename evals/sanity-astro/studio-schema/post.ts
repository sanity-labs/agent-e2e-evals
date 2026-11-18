// Reference copy of the Studio's post type (the Studio itself lives in another repository).
import { defineField, defineType } from 'sanity';

export const post = defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'slug', type: 'slug', options: { source: 'title' } }),
    defineField({ name: 'author', type: 'reference', to: [{ type: 'author' }] }),
    defineField({ name: 'publishedAt', title: 'Publish date', type: 'datetime' }),
    defineField({
      name: 'mainImage',
      type: 'image',
      options: { hotspot: true },
      fields: [defineField({ name: 'alt', title: 'Alternative text', type: 'string' })],
    }),
    defineField({ name: 'body', type: 'array', of: [{ type: 'block' }] }),
  ],
});
