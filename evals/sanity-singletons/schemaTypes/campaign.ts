import {defineField, defineType} from 'sanity'

export const campaign = defineType({
  name: 'campaign',
  title: 'Campaign',
  type: 'document',
  fields: [
    defineField({name: 'title', type: 'string', validation: (rule) => rule.required()}),
    defineField({
      name: 'season',
      type: 'string',
      options: {list: ['spring', 'summer', 'autumn', 'winter']},
    }),
    defineField({name: 'headline', type: 'string'}),
  ],
})
