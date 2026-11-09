import Link from 'next/link';
import { getPosts } from '../../lib/sanity';

export default async function PostsPage() {
  const posts = await getPosts();
  return <main><h1>Posts</h1><ul>{posts.map((post) =>
    <li key={post._id}><Link href={`/posts/${post.slug}`} data-title={post.title}>{post.title}</Link></li>
  )}</ul></main>;
}
