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
import { pathToFileURL } from 'node:url';
import { load, type CheerioAPI } from 'cheerio';
import { beforeAll, expect, test } from 'vitest';

type Doc = Record<string, any>;
const span = (_key: string, text: string, marks: string[] = []) => ({ _key, _type: 'span', text, marks });
const para = (_key: string, children: Doc[], markDefs: Doc[] = []) => ({
  _key,
  _type: 'block',
  style: 'normal',
  markDefs,
  children,
});
const asset = (_id: string, width: number, height: number, extension: string) => ({
  _id,
  _type: 'sanity.imageAsset',
  extension,
  mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
  url: `https://cdn.sanity.io/images/abc123/production/${_id.slice(6, _id.lastIndexOf('-'))}.${extension}`,
  metadata: { dimensions: { width, height, aspectRatio: width / height } },
});
/** A post with two paragraphs: plain text, a bold and an italic span, and a link. */
const post = (
  _id: string,
  title: string,
  slug: string | null,
  author: string,
  publishedAt: string,
  image: string,
  alt: string,
  [bold, italic, linkText, href, extra]: [string, string, string, string, string],
) => ({
  _id,
  _type: 'post',
  title,
  ...(slug ? { slug: { _type: 'slug', current: slug } } : {}),
  author: { _type: 'reference', _ref: author },
  publishedAt,
  mainImage: { _type: 'image', asset: { _type: 'reference', _ref: image }, alt },
  body: [
    para('p1', [
      span('s1', `${title} begins here. `),
      span('s2', bold, ['strong']),
      span('s3', ' and '),
      span('s4', italic, ['em']),
      span('s5', '.'),
    ]),
    para(
      'p2',
      [span('s6', 'Read '), span('s7', linkText, ['l1']), span('s8', ` for more. ${extra}`)],
      [{ _key: 'l1', _type: 'link', href }],
    ),
  ],
});
const JPG = 'image-0c1d2e3f4a5b6c7d8e9f-2000x1333-jpg';
const WEBP = 'image-5e5e5e5e5e5e5e5e5e5e-800x800-webp';
const PNG = 'image-77aa88bb99cc00dd11ee-1024x768-png';
const BREAD = ['patience', 'warm water', 'a starter recipe', 'https://bake.example.net/starter'] as const;
/** Hidden content: same shape as data/sample.ndjson, different values. Every referenced author and image asset is present. */
const HIDDEN: Doc[] = [
  { _id: 'author-lena', _type: 'author', name: 'Lena Brandt' },
  { _id: 'author-kofi', _type: 'author', name: 'Kofi Mensah' },
  { _id: 'author-yuki', _type: 'author', name: 'Yuki Tanaka' },
  asset(JPG, 2000, 1333, 'jpg'),
  asset(WEBP, 800, 800, 'webp'),
  asset(PNG, 1024, 768, 'png'),
  post(
    'post-h-harbour',
    'Winter at the harbour',
    'winter-at-the-harbour',
    'author-lena',
    '2026-01-19T07:45:00Z',
    JPG,
    'Fishing boats under snow',
    ['frozen ropes', 'slow mornings', 'the tide table', 'https://tides.example.org/winter', 'Bring gloves.'],
  ),
  post(
    'post-h-bread',
    'Bread for beginners',
    'bread-for-beginners',
    'author-kofi',
    '2026-05-27T16:10:00Z',
    WEBP,
    'A round loaf on a board',
    [...BREAD, 'Let it rest.'],
  ),
  post(
    'post-h-maps',
    'Reading old maps',
    'reading-old-maps',
    'author-yuki',
    '2026-03-13T10:00:00Z',
    PNG,
    'A hand-drawn coastline',
    ['compass roses', 'faded ink', 'the archive', 'https://archive.example.com/maps?ref=blog', 'Mind the scale.'],
  ),
  post(
    'post-h-noslug',
    'Unfinished: a post without a slug',
    null,
    'author-lena',
    '2026-06-28T09:00:00Z',
    JPG,
    'Empty quay',
    ['not ready', 'yet', 'nowhere', 'https://example.com/none', ''],
  ),
  post(
    'drafts.post-h-secret',
    'Secret draft post',
    'secret-draft-post',
    'author-kofi',
    '2026-07-14T09:00:00Z',
    WEBP,
    'Hidden',
    ['draft', 'only', 'hidden', 'https://example.com/hidden', ''],
  ),
  post(
    'drafts.post-h-bread',
    'Bread for beginners (draft edit)',
    'bread-for-beginners',
    'author-kofi',
    '2026-05-27T16:10:00Z',
    WEBP,
    'A round loaf on a board',
    [...BREAD, 'Draft only.'],
  ),
];

const byId = new Map(HIDDEN.map((d) => [d._id, d]));
const published = HIDDEN.filter((d) => d._type === 'post' && !d._id.startsWith('drafts.'));
const listed = published.filter((d) => d.slug?.current).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
const notListed = HIDDEN.filter((d) => d._type === 'post' && !listed.includes(d));
const spans = (post: Doc, mark: string) =>
  post.body.flatMap((b: Doc) => b.children.filter((c: Doc) => c.marks.includes(mark)).map((c: Doc) => c.text));
/** The plain (unmarked) text of each paragraph, trimmed, so ordinary prose must appear too. */
const plainTexts = (post: Doc) =>
  post.body.flatMap((b: Doc) =>
    b.children
      .filter((c: Doc) => c.marks.length === 0)
      .map((c: Doc) => c.text.trim())
      .filter(Boolean),
  );
const linkOf = (post: Doc) => {
  const block = post.body.find((b: Doc) => b.markDefs.length);
  const def = block.markDefs[0];
  return { href: def.href, text: block.children.find((c: Doc) => c.marks.includes(def._key)).text };
};
/** True when `url` is a Sanity CDN URL for this asset (`image-<hash>-<w>x<h>-<ext>`): host cdn.sanity.io, path
 * /images/abc123/production/<hash>-<w>x<h>.<any ext>, any query parameters. */
const isCdnUrl = (url: string, assetId: string) => {
  const stem = assetId.replace(/^image-/, '').replace(/-[a-z0-9]+$/, '');
  try {
    const u = new URL(url, 'http://invalid.local/');
    return (
      u.protocol === 'https:' &&
      u.hostname === 'cdn.sanity.io' &&
      new RegExp(`^/images/abc123/production/${stem}\\.[a-z0-9]+$`).test(u.pathname)
    );
  } catch {
    return false;
  }
};
/** src plus every srcset candidate URL. */
const imageUrls = (src: string | undefined, srcset: string | undefined) => [
  ...(src ? [src.trim()] : []),
  ...(srcset ?? '')
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean),
];
/** The origin of the `site` in the agent's Astro config, so absolute links to it count as the site's own. Relative
 * links always count. Uses Astro's own config resolver (pinned astro), so variables and imports in the config work. */
const siteOrigin = (() => {
  const resolver = pathToFileURL(join(process.cwd(), 'node_modules/astro/dist/core/config/index.js')).href;
  const script = `const { resolveConfig } = await import(${JSON.stringify(resolver)});
const { astroConfig } = await resolveConfig({ root: process.cwd() }, 'build');
console.log(JSON.stringify(astroConfig.site ?? ''));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  try {
    return new URL(JSON.parse(r.stdout.trim().split('\n').pop()!)).origin;
  } catch {
    return undefined;
  }
})();
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
  expect(build.status, 'the site did not build with the hidden content').toBe(0);
  const $ = readPage(['posts/index.html', 'posts.html']);
  expect($, 'no /posts/ page was built').toBeDefined();
  const slugs: string[] = [];
  $!('a[href]').each((_, a) => {
    const url = new URL($!(a).attr('href')!, 'http://site/posts/');
    // Links to another site don't count as the site's own post links.
    if (url.origin !== 'http://site' && url.origin !== siteOrigin) return;
    const path = url.pathname;
    const slug = path.match(/^\/posts\/([^/]+)\/?$/)?.[1];
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  });
  expect(slugs).toEqual(listed.map((p) => p.slug.current));
  const listText = text($!, 'body');
  for (const post of notListed) expect(listText, `${post._id} is shown on /posts/`).not.toContain(post.title);
});

test('drafts and posts without a slug are not shown', () => {
  expect(build.status, 'the site did not build with the hidden content').toBe(0);
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
    expect(build.status, 'the site did not build with the hidden content').toBe(0);
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
    const body = text($, 'body');
    for (const words of plainTexts(post)) expect(body, `paragraph text "${words}"`).toContain(words);
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
    const assetId = post.mainImage.asset._ref;
    const ok = $('img')
      .toArray()
      .some(
        (img) =>
          $(img).attr('alt') === post.mainImage.alt &&
          imageUrls($(img).attr('src'), $(img).attr('srcset')).some((u) => isCdnUrl(u, assetId)),
      );
    expect(ok, `<img alt="${post.mainImage.alt}"> with a cdn.sanity.io URL for ${assetId}`).toBe(true);
  });
}
