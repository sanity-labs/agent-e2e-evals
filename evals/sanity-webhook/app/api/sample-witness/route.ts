import { client, witnessQuery } from '../../../lib/sanity';

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get('slug') ?? '';
  const post = await client.fetch(witnessQuery, { slug }, { cache: 'no-store' });
  return Response.json(post);
}
