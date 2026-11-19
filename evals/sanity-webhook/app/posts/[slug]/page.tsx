import { notFound } from 'next/navigation';
import { getPost, getPosts } from '../../../lib/sanity';

export async function generateStaticParams() {
  return (await getPosts()).map(({ slug }) => ({ slug }));
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  return <main><h1 data-title={post.title}>{post.title}</h1></main>;
}
