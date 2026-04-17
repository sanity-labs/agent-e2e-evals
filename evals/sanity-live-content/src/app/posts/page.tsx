import { client } from '@/sanity/lib/client';

const POSTS_QUERY = `*[_type == "post"] | order(publishedAt desc) {
  _id,
  title,
  "slug": slug.current,
  publishedAt
}`;

export const dynamic = 'force-dynamic';

export default async function PostsPage() {
  const posts = await client.fetch(POSTS_QUERY);

  return (
    <main>
      <h1>Posts</h1>
      <ul>
        {posts.map((post: any) => (
          <li key={post._id}>
            <a href={`/posts/${post.slug}`}>{post.title}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
