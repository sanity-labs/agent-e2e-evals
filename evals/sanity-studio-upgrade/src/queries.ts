import {defineQuery} from 'groq'

export const LATEST_POSTS_QUERY = defineQuery(
  `*[_type == "post" && defined(slug.current)] | order(publishedAt desc)[0...10]{_id, title, "slug": slug.current, "author": author->name}`,
)
