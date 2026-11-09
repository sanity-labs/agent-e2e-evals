import { createClient } from 'next-sanity';

export const client = createClient({
  projectId: 'abc123',
  dataset: 'production',
  apiVersion: '2024-06-01',
  useCdn: false,
});

export type Post = { _id: string; title: string; slug: string };
export const postsQuery = `*[_type == "post" && defined(slug.current)] | order(_id asc){_id,title,"slug":slug.current}`;
export const postQuery = `*[_type == "post" && slug.current == $slug][0]{_id,title,"slug":slug.current}`;

export const getPosts = () =>
  client.fetch<Post[]>(postsQuery, {}, { cache: 'force-cache', next: { tags: ['post'] } });
export const getPost = (slug: string) =>
  client.fetch<Post | null>(postQuery, { slug }, { cache: 'force-cache', next: { tags: ['post', `post:${slug}`] } });
