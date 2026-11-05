/**
 * Offline grader for sanity-astro (design: /workspace/evals/astro-pilot/DESIGN.md v2).
 * Rebuilds the site with the fixture's own `npm run build` (protected package.json and scripts/sample-api.mjs), but
 * with the local content API serving a hidden dataset that differs from data/sample.ndjson, then checks the built HTML.
 * A build that fails or lacks pages fails the content tests. The request log is printed for diagnosis, not graded.
 * A pass means the built pages show the right content from this offline stand-in; it doesn't test a live project,
 * the dev server, previews or styling.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, type CheerioAPI } from 'cheerio';
import { beforeAll, expect, test } from 'vitest';

type Doc = Record<string, any>;
/** Hidden content: same shape as the sample, different values. Every referenced author and image asset is present. */
const HIDDEN: Doc[] = [
  {
    _id: 'author-lena',
    _type: 'author',
    name: 'Lena Brandt',
  },
  {
    _id: 'author-kofi',
    _type: 'author',
    name: 'Kofi Mensah',
  },
  {
    _id: 'author-yuki',
    _type: 'author',
    name: 'Yuki Tanaka',
  },
  {
    _id: 'image-0c1d2e3f4a5b6c7d8e9f-2000x1333-jpg',
    _type: 'sanity.imageAsset',
    extension: 'jpg',
    mimeType: 'image/jpeg',
    url: 'https://cdn.sanity.io/images/abc123/production/0c1d2e3f4a5b6c7d8e9f-2000x1333.jpg',
    metadata: {
      dimensions: {
        width: 2000,
        height: 1333,
        aspectRatio: 1.5003750937734435,
      },
    },
  },
  {
    _id: 'image-5e5e5e5e5e5e5e5e5e5e-800x800-webp',
    _type: 'sanity.imageAsset',
    extension: 'webp',
    mimeType: 'image/webp',
    url: 'https://cdn.sanity.io/images/abc123/production/5e5e5e5e5e5e5e5e5e5e-800x800.webp',
    metadata: {
      dimensions: {
        width: 800,
        height: 800,
        aspectRatio: 1,
      },
    },
  },
  {
    _id: 'image-77aa88bb99cc00dd11ee-1024x768-png',
    _type: 'sanity.imageAsset',
    extension: 'png',
    mimeType: 'image/png',
    url: 'https://cdn.sanity.io/images/abc123/production/77aa88bb99cc00dd11ee-1024x768.png',
    metadata: {
      dimensions: {
        width: 1024,
        height: 768,
        aspectRatio: 1.3333333333333333,
      },
    },
  },
  {
    _id: 'post-h-harbour',
    _type: 'post',
    title: 'Winter at the harbour',
    slug: {
      _type: 'slug',
      current: 'winter-at-the-harbour',
    },
    author: {
      _type: 'reference',
      _ref: 'author-lena',
    },
    publishedAt: '2026-01-19T07:45:00Z',
    mainImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: 'image-0c1d2e3f4a5b6c7d8e9f-2000x1333-jpg',
      },
      alt: 'Fishing boats under snow',
    },
    body: [
      {
        _key: 'p1',
        _type: 'block',
        style: 'normal',
        markDefs: [],
        children: [
          {
            _key: 's1',
            _type: 'span',
            text: 'Winter at the harbour begins here. ',
            marks: [],
          },
          {
            _key: 's2',
            _type: 'span',
            text: 'frozen ropes',
            marks: ['strong'],
          },
          {
            _key: 's3',
            _type: 'span',
            text: ' and ',
            marks: [],
          },
          {
            _key: 's4',
            _type: 'span',
            text: 'slow mornings',
            marks: ['em'],
          },
          {
            _key: 's5',
            _type: 'span',
            text: '.',
            marks: [],
          },
        ],
      },
      {
        _key: 'p2',
        _type: 'block',
        style: 'normal',
        markDefs: [
          {
            _key: 'l1',
            _type: 'link',
            href: 'https://tides.example.org/winter',
          },
        ],
        children: [
          {
            _key: 's6',
            _type: 'span',
            text: 'Read ',
            marks: [],
          },
          {
            _key: 's7',
            _type: 'span',
            text: 'the tide table',
            marks: ['l1'],
          },
          {
            _key: 's8',
            _type: 'span',
            text: ' for more. Bring gloves.',
            marks: [],
          },
        ],
      },
    ],
  },
  {
    _id: 'post-h-bread',
    _type: 'post',
    title: 'Bread for beginners',
    slug: {
      _type: 'slug',
      current: 'bread-for-beginners',
    },
    author: {
      _type: 'reference',
      _ref: 'author-kofi',
    },
    publishedAt: '2026-05-27T16:10:00Z',
    mainImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: 'image-5e5e5e5e5e5e5e5e5e5e-800x800-webp',
      },
      alt: 'A round loaf on a board',
    },
    body: [
      {
        _key: 'p1',
        _type: 'block',
        style: 'normal',
        markDefs: [],
        children: [
          {
            _key: 's1',
            _type: 'span',
            text: 'Bread for beginners begins here. ',
            marks: [],
          },
          {
            _key: 's2',
            _type: 'span',
            text: 'patience',
            marks: ['strong'],
          },
          {
            _key: 's3',
            _type: 'span',
            text: ' and ',
            marks: [],
          },
          {
            _key: 's4',
            _type: 'span',
            text: 'warm water',
            marks: ['em'],
          },
          {
            _key: 's5',
            _type: 'span',
            text: '.',
            marks: [],
          },
        ],
      },
      {
        _key: 'p2',
        _type: 'block',
        style: 'normal',
        markDefs: [
          {
            _key: 'l1',
            _type: 'link',
            href: 'https://bake.example.net/starter',
          },
        ],
        children: [
          {
            _key: 's6',
            _type: 'span',
            text: 'Read ',
            marks: [],
          },
          {
            _key: 's7',
            _type: 'span',
            text: 'a starter recipe',
            marks: ['l1'],
          },
          {
            _key: 's8',
            _type: 'span',
            text: ' for more. Let it rest.',
            marks: [],
          },
        ],
      },
    ],
  },
  {
    _id: 'post-h-maps',
    _type: 'post',
    title: 'Reading old maps',
    slug: {
      _type: 'slug',
      current: 'reading-old-maps',
    },
    author: {
      _type: 'reference',
      _ref: 'author-yuki',
    },
    publishedAt: '2026-03-13T10:00:00Z',
    mainImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: 'image-77aa88bb99cc00dd11ee-1024x768-png',
      },
      alt: 'A hand-drawn coastline',
    },
    body: [
      {
        _key: 'p1',
        _type: 'block',
        style: 'normal',
        markDefs: [],
        children: [
          {
            _key: 's1',
            _type: 'span',
            text: 'Reading old maps begins here. ',
            marks: [],
          },
          {
            _key: 's2',
            _type: 'span',
            text: 'compass roses',
            marks: ['strong'],
          },
          {
            _key: 's3',
            _type: 'span',
            text: ' and ',
            marks: [],
          },
          {
            _key: 's4',
            _type: 'span',
            text: 'faded ink',
            marks: ['em'],
          },
          {
            _key: 's5',
            _type: 'span',
            text: '.',
            marks: [],
          },
        ],
      },
      {
        _key: 'p2',
        _type: 'block',
        style: 'normal',
        markDefs: [
          {
            _key: 'l1',
            _type: 'link',
            href: 'https://archive.example.com/maps?ref=blog',
          },
        ],
        children: [
          {
            _key: 's6',
            _type: 'span',
            text: 'Read ',
            marks: [],
          },
          {
            _key: 's7',
            _type: 'span',
            text: 'the archive',
            marks: ['l1'],
          },
          {
            _key: 's8',
            _type: 'span',
            text: ' for more. Mind the scale.',
            marks: [],
          },
        ],
      },
    ],
  },
  {
    _id: 'post-h-noslug',
    _type: 'post',
    title: 'Unfinished: a post without a slug',
    author: {
      _type: 'reference',
      _ref: 'author-lena',
    },
    publishedAt: '2026-06-28T09:00:00Z',
    mainImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: 'image-0c1d2e3f4a5b6c7d8e9f-2000x1333-jpg',
      },
      alt: 'Empty quay',
    },
    body: [
      {
        _key: 'p1',
        _type: 'block',
        style: 'normal',
        markDefs: [],
        children: [
          {
            _key: 's1',
            _type: 'span',
            text: 'Unfinished: a post without a slug begins here. ',
            marks: [],
          },
          {
            _key: 's2',
            _type: 'span',
            text: 'not ready',
            marks: ['strong'],
          },
          {
            _key: 's3',
            _type: 'span',
            text: ' and ',
            marks: [],
          },
          {
            _key: 's4',
            _type: 'span',
            text: 'yet',
            marks: ['em'],
          },
          {
            _key: 's5',
            _type: 'span',
            text: '.',
            marks: [],
          },
        ],
      },
      {
        _key: 'p2',
        _type: 'block',
        style: 'normal',
        markDefs: [
          {
            _key: 'l1',
            _type: 'link',
            href: 'https://example.com/none',
          },
        ],
        children: [
          {
            _key: 's6',
            _type: 'span',
            text: 'Read ',
            marks: [],
          },
          {
            _key: 's7',
            _type: 'span',
            text: 'nowhere',
            marks: ['l1'],
          },
          {
            _key: 's8',
            _type: 'span',
            text: ' for more. ',
            marks: [],
          },
        ],
      },
    ],
  },
  {
    _id: 'drafts.post-h-secret',
    _type: 'post',
    title: 'Secret draft post',
    slug: {
      _type: 'slug',
      current: 'secret-draft-post',
    },
    author: {
      _type: 'reference',
      _ref: 'author-kofi',
    },
    publishedAt: '2026-07-14T09:00:00Z',
    mainImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: 'image-5e5e5e5e5e5e5e5e5e5e-800x800-webp',
      },
      alt: 'Hidden',
    },
    body: [
      {
        _key: 'p1',
        _type: 'block',
        style: 'normal',
        markDefs: [],
        children: [
          {
            _key: 's1',
            _type: 'span',
            text: 'Secret draft post begins here. ',
            marks: [],
          },
          {
            _key: 's2',
            _type: 'span',
            text: 'draft',
            marks: ['strong'],
          },
          {
            _key: 's3',
            _type: 'span',
            text: ' and ',
            marks: [],
          },
          {
            _key: 's4',
            _type: 'span',
            text: 'only',
            marks: ['em'],
          },
          {
            _key: 's5',
            _type: 'span',
            text: '.',
            marks: [],
          },
        ],
      },
      {
        _key: 'p2',
        _type: 'block',
        style: 'normal',
        markDefs: [
          {
            _key: 'l1',
            _type: 'link',
            href: 'https://example.com/hidden',
          },
        ],
        children: [
          {
            _key: 's6',
            _type: 'span',
            text: 'Read ',
            marks: [],
          },
          {
            _key: 's7',
            _type: 'span',
            text: 'hidden',
            marks: ['l1'],
          },
          {
            _key: 's8',
            _type: 'span',
            text: ' for more. ',
            marks: [],
          },
        ],
      },
    ],
  },
  {
    _id: 'drafts.post-h-bread',
    _type: 'post',
    title: 'Bread for beginners (draft edit)',
    slug: {
      _type: 'slug',
      current: 'bread-for-beginners',
    },
    author: {
      _type: 'reference',
      _ref: 'author-kofi',
    },
    publishedAt: '2026-05-27T16:10:00Z',
    mainImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: 'image-5e5e5e5e5e5e5e5e5e5e-800x800-webp',
      },
      alt: 'A round loaf on a board',
    },
    body: [
      {
        _key: 'p1',
        _type: 'block',
        style: 'normal',
        markDefs: [],
        children: [
          {
            _key: 's1',
            _type: 'span',
            text: 'Bread for beginners (draft edit) begins here. ',
            marks: [],
          },
          {
            _key: 's2',
            _type: 'span',
            text: 'patience',
            marks: ['strong'],
          },
          {
            _key: 's3',
            _type: 'span',
            text: ' and ',
            marks: [],
          },
          {
            _key: 's4',
            _type: 'span',
            text: 'warm water',
            marks: ['em'],
          },
          {
            _key: 's5',
            _type: 'span',
            text: '.',
            marks: [],
          },
        ],
      },
      {
        _key: 'p2',
        _type: 'block',
        style: 'normal',
        markDefs: [
          {
            _key: 'l1',
            _type: 'link',
            href: 'https://bake.example.net/starter',
          },
        ],
        children: [
          {
            _key: 's6',
            _type: 'span',
            text: 'Read ',
            marks: [],
          },
          {
            _key: 's7',
            _type: 'span',
            text: 'a starter recipe',
            marks: ['l1'],
          },
          {
            _key: 's8',
            _type: 'span',
            text: ' for more. Draft only.',
            marks: [],
          },
        ],
      },
    ],
  },
];

const byId = new Map(HIDDEN.map((d) => [d._id, d]));
const published = HIDDEN.filter((d) => d._type === 'post' && !d._id.startsWith('drafts.'));
const listed = published.filter((d) => d.slug?.current).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
const notListed = HIDDEN.filter((d) => d._type === 'post' && !listed.includes(d));
const spans = (post: Doc, mark: string) =>
  post.body.flatMap((b: Doc) => b.children.filter((c: Doc) => c.marks.includes(mark)).map((c: Doc) => c.text));
const linkOf = (post: Doc) => {
  const block = post.body.find((b: Doc) => b.markDefs.length);
  const def = block.markDefs[0];
  return { href: def.href, text: block.children.find((c: Doc) => c.marks.includes(def._key)).text };
};
/** `image-<hash>-<w>x<h>-<ext>` → the CDN path without extension, so format changes are accepted. */
const cdnPath = (assetId: string) =>
  `cdn.sanity.io/images/abc123/production/${assetId.replace(/^image-/, '').replace(/-[a-z0-9]+$/, '')}`;
const text = ($: CheerioAPI, sel: string) => $(sel).text().replace(/\s+/g, ' ').trim();

let build: { status: number | null; output: string };
const pages = new Map<string, CheerioAPI | undefined>();
const readPage = (rel: string[]) => {
  const file = rel.map((r) => join('dist', r)).find(existsSync);
  return file ? load(readFileSync(file, 'utf8')) : undefined;
};

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'astro-grade-'));
  const data = join(dir, 'hidden.ndjson');
  const log = join(dir, 'requests.jsonl');
  writeFileSync(data, HIDDEN.map((d) => JSON.stringify(d)).join('\n') + '\n');
  rmSync('dist', { recursive: true, force: true });
  const r = spawnSync('npm', ['run', 'build'], {
    env: { ...process.env, SAMPLE_API_DATA: data, SAMPLE_API_LOG: log },
    encoding: 'utf8',
    timeout: 600_000,
  });
  build = { status: r.status, output: `${r.stdout}\n${r.stderr}`.slice(-4000) };
  const requests = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  console.log(
    `hidden-data build exit ${r.status}${r.error ? ` (${r.error.message})` : ''}; ${requests.length} API requests`,
  );
  for (const line of requests) console.log(`request: ${line.slice(0, 300)}`);
  for (const post of HIDDEN.filter((d) => d._type === 'post' && d.slug?.current)) {
    const slug = post.slug.current;
    pages.set(slug, readPage([`posts/${slug}/index.html`, `posts/${slug}.html`]));
  }
}, 660_000);

test('the site builds with the hidden content', () => {
  expect(build.status, build.output).toBe(0);
});

test('/posts/ lists exactly the published posts with a slug, newest first', () => {
  const $ = readPage(['posts/index.html', 'posts.html']);
  expect($, 'no /posts/ page was built').toBeDefined();
  const slugs: string[] = [];
  $!('a[href]').each((_, a) => {
    const path = new URL($!(a).attr('href')!, 'http://site/posts/').pathname;
    const slug = path.match(/^\/posts\/([^/]+)\/?$/)?.[1];
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  });
  expect(slugs).toEqual(listed.map((p) => p.slug.current));
});

test('drafts and posts without a slug are not shown', () => {
  const listedSlugs = new Set(listed.map((p) => p.slug.current));
  for (const post of notListed) {
    const slug = post.slug?.current;
    if (!slug) continue;
    if (!listedSlugs.has(slug)) {
      expect(pages.get(slug), `page built for ${post._id}`).toBeUndefined();
    } else {
      // A draft edit of a published post: the published page must not show the draft's changed title.
      const $ = pages.get(slug);
      if ($) expect(text($, 'body'), `draft content of ${post._id} shown`).not.toContain(post.title);
    }
  }
});

for (const post of listed) {
  const slug = post.slug.current;
  const page = () => {
    const $ = pages.get(slug);
    expect($, `no page was built at /posts/${slug}/`).toBeDefined();
    return $!;
  };
  test(`${slug}: title and author name`, () => {
    const body = text(page(), 'body');
    expect(body).toContain(post.title);
    expect(body).toContain(byId.get(post.author._ref)!.name);
  });
  test(`${slug}: publish date in <time datetime> with a label`, () => {
    const $ = page();
    const day = post.publishedAt.slice(0, 10);
    // Parsed natively and compared as a UTC calendar date, so equivalent offset timestamps count; the label just needs text.
    const utcDay = (v: string) => {
      const t = Date.parse(v);
      return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
    };
    const times = $('time[datetime]')
      .toArray()
      .filter((t) => utcDay($(t).attr('datetime') ?? '') === day && $(t).text().trim() !== '');
    expect(times.length, `no <time> whose datetime is ${day} (UTC) with a label`).toBeGreaterThan(0);
  });
  test(`${slug}: body keeps bold, italic and links`, () => {
    const $ = page();
    const within = (sel: string, words: string) =>
      $(sel)
        .toArray()
        .some((el) => $(el).text().includes(words));
    for (const words of spans(post, 'strong')) expect(within('strong, b', words), `bold "${words}"`).toBe(true);
    for (const words of spans(post, 'em')) expect(within('em, i', words), `italic "${words}"`).toBe(true);
    const link = linkOf(post);
    const ok = $('a[href]')
      .toArray()
      .some((a) => {
        try {
          return new URL($(a).attr('href')!).href === new URL(link.href).href && $(a).text().includes(link.text);
        } catch {
          return false;
        }
      });
    expect(ok, `link "${link.text}" to ${link.href}`).toBe(true);
  });
  test(`${slug}: main image from the Sanity CDN with its alt text`, () => {
    const $ = page();
    const want = cdnPath(post.mainImage.asset._ref);
    const ok = $('img')
      .toArray()
      .some(
        (img) =>
          $(img).attr('alt') === post.mainImage.alt &&
          `${$(img).attr('src') ?? ''} ${$(img).attr('srcset') ?? ''}`.includes(want),
      );
    expect(ok, `<img alt="${post.mainImage.alt}"> with ${want}`).toBe(true);
  });
}
