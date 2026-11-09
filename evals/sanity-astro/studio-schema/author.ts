// Reference copy of the Studio's author type (the Studio itself lives in another repository).
import { defineField, defineType } from 'sanity';

export const author = defineType({
  name: 'author',
  title: 'Author',
  type: 'document',
  fields: [defineField({ name: 'name', type: 'string', validation: (rule) => rule.required() })],
});
