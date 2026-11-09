import type {LATEST_POSTS_QUERYResult} from './sanity.types'

export function postTitles(posts: LATEST_POSTS_QUERYResult): string[] {
  return posts.map((post) => post.title ?? 'Untitled')
}
