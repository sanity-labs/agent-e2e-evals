import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { expect, test } from 'vitest';

// This eval checks that the agent rebuilt the post detail page that was
// surgically removed from the official `sanity-io/sanity-template-nextjs-clean`
// fixture. The home page already lists posts via `AllPosts` and each card
// links to `/posts/<slug>`, but those URLs 404 because the route and its GROQ
// query are missing. A correct solution adds a non-trivial GROQ query (post
// fields + author dereferencing + portable text content with link refs), wires
// up `frontend/app/posts/[slug]/page.{ts,tsx}`, and uses the existing
// rendering components (Avatar, PortableText, SanityImage).

async function readFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// Locate the post detail route file. The conventional path is
// `frontend/app/posts/[slug]/page.tsx`, but we accept any `[slug]/page.{ts,tsx}`
// under `frontend/app/posts/**` so the agent isn't penalised for tweaking the
// route layout (e.g. an intermediate group segment).
async function findPostDetailRoute(): Promise<string | undefined> {
  for await (const filePath of fs.glob('frontend/app/posts/**/[[]slug[]]/page.{ts,tsx,js,jsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    return filePath;
  }
  return undefined;
}

// Locate any module that exports a `postQuery` (or anything ending in
// `PostQuery`) so the agent isn't forced to put it in a specific file. The
// rest of the template stores GROQ in `frontend/sanity/lib/queries.ts`, which
// is the natural home, but we don't want to fail an otherwise-correct
// solution that picked a slightly different filename.
async function findPostQueryModule(): Promise<{ filePath: string; content: string; exportName: string } | undefined> {
  const exportRe = /export\s+const\s+(\w*postQuery)\b/i;
  for await (const filePath of fs.glob('frontend/**/*.{ts,tsx,js,jsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    const content = await readFile(filePath);
    if (!content) continue;
    const match = content.match(exportRe);
    if (match) return { filePath, content, exportName: match[1]! };
  }
  return undefined;
}

// Locate any module that exports a slugs-only query for posts (the query that
// `generateStaticParams` consumes). We accept any export name so long as the
// query body looks right (filters posts by `defined(slug.current)` and
// projects only the slug).
async function findPostSlugsQueryModule(): Promise<
  { filePath: string; content: string; exportName: string } | undefined
> {
  const exportRe = /export\s+const\s+(\w+)\s*=\s*defineQuery\s*\(\s*([`'"])([\s\S]*?)\2\s*\)/g;
  for await (const filePath of fs.glob('frontend/**/*.{ts,tsx,js,jsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    const content = await readFile(filePath);
    if (!content) continue;
    for (const match of content.matchAll(exportRe)) {
      const [, exportName, , body] = match;
      if (!body || !exportName) continue;
      const filtersOnPostOnly = /_type\s*==\s*['"]post['"]/.test(body) && !/_type\s*==\s*['"]page['"]/.test(body);
      const requiresDefinedSlug = /defined\(\s*slug\.current\s*\)/.test(body);
      const projectsSlug = /slug\.current/.test(body);
      // A slugs-only query shouldn't pull in heavy field fragments — neither
      // literal projections like `coverImage` nor `${postFields}`-style
      // interpolations.
      const notFullPost =
        !/author\s*->/.test(body) &&
        !/coverImage/.test(body) &&
        !/excerpt/.test(body) &&
        !/\bcontent\b/.test(body) &&
        !/\$\{[^}]*\}/.test(body);
      if (filtersOnPostOnly && requiresDefinedSlug && projectsSlug && notFullPost) {
        return { filePath, content, exportName };
      }
    }
  }
  return undefined;
}

const postDetailRoutePath = await findPostDetailRoute();
const postQueryModule = await findPostQueryModule();
const postSlugsModule = await findPostSlugsQueryModule();

test('Post detail route exists at `frontend/app/posts/[slug]/page.{ts,tsx}`', () => {
  expect(
    postDetailRoutePath,
    'expected a Next.js route handler at `frontend/app/posts/[slug]/page.{ts,tsx}` so cards on the home page can link to individual posts',
  ).not.toBeUndefined();
});

test('A `postQuery` is exported from a queries module', () => {
  expect(
    postQueryModule,
    'expected a module under `frontend/` that exports `postQuery` (a GROQ query that fetches a single post by slug)',
  ).not.toBeUndefined();
});

test('`postQuery` is built with `defineQuery` from `next-sanity`', () => {
  expect(postQueryModule, 'cannot check `defineQuery` usage without `postQuery`').not.toBeUndefined();
  const { content, exportName } = postQueryModule!;
  expect(
    content,
    'expected the queries module to import `defineQuery` from `next-sanity` (matches the rest of the template)',
  ).toMatch(/from\s+['"]next-sanity['"]/);
  expect(
    content,
    `expected \`${exportName}\` to be wrapped in \`defineQuery(...)\` so its result can be typed by Sanity TypeGen`,
  ).toMatch(new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*defineQuery\\s*\\(`));
});

test('`postQuery` filters posts by `slug.current == $slug` and returns a single document', () => {
  expect(postQueryModule, 'cannot check filter shape without `postQuery`').not.toBeUndefined();
  const { content, exportName } = postQueryModule!;
  // Pull just the postQuery body to assert against — otherwise unrelated
  // queries in the same file could satisfy these patterns.
  const bodyRe = new RegExp(
    `export\\s+const\\s+${exportName}\\s*=\\s*defineQuery\\s*\\(\\s*([\`'"])([\\s\\S]*?)\\1\\s*\\)`,
  );
  const bodyMatch = content.match(bodyRe);
  expect(bodyMatch, `expected to extract the body of \`${exportName}\``).not.toBeNull();
  const body = bodyMatch![2]!;

  expect(body, `expected \`${exportName}\` to filter \`_type == "post"\``).toMatch(/_type\s*==\s*['"]post['"]/);
  expect(body, `expected \`${exportName}\` to filter by \`slug.current == $slug\``).toMatch(
    /slug\.current\s*==\s*\$slug/,
  );
  // The frontend uses `data._id`, `data.title`, etc. directly — without `[0]`
  // the query returns an array and the consumer code breaks at runtime.
  expect(body, `expected \`${exportName}\` to return a single post via \`[0]\``).toMatch(/\[\s*0\s*\]/);
});

test('`postQuery` projects the fields the page needs (content, author dereferenced, coverImage, title)', () => {
  expect(postQueryModule, 'cannot check projections without `postQuery`').not.toBeUndefined();
  const { content: fileContent, exportName } = postQueryModule!;
  const bodyRe = new RegExp(
    `export\\s+const\\s+${exportName}\\s*=\\s*defineQuery\\s*\\(\\s*([\`'"])([\\s\\S]*?)\\1\\s*\\)`,
  );
  const bodyMatch = fileContent.match(bodyRe);
  expect(bodyMatch, `expected to extract the body of \`${exportName}\``).not.toBeNull();
  const body = bodyMatch![2]!;

  // The page renders `<PortableText value={post.content} />`, so the query
  // has to project content. Because content has nested portable text with
  // link markDefs, the body itself usually mentions `content` even when the
  // rest of the projection is delegated to a fragment.
  expect(
    body,
    `expected \`${exportName}\` to project \`content\` so the post body can be rendered with PortableText`,
  ).toMatch(/\bcontent\b/);

  // The remaining fields are commonly delegated to a `${postFields}`-style
  // fragment in the same file, so we look across the whole module instead of
  // just the postQuery body. Using `fileContent` here is intentional.
  expect(
    fileContent,
    'expected the queries module to dereference `author` (e.g. `author->{firstName, lastName, picture}`) — without it, Avatar has no name/picture to render',
  ).toMatch(/author\s*->/);
  expect(fileContent, 'expected the queries module to project `coverImage` for the post').toMatch(/\bcoverImage\b/);
  expect(fileContent, 'expected the queries module to project `title` for the post').toMatch(/\btitle\b/);
});

test('A slugs-only post query exists for `generateStaticParams`', () => {
  expect(
    postSlugsModule,
    'expected a separate GROQ query that returns just `{ slug }` for every post (used by Next.js `generateStaticParams`)',
  ).not.toBeUndefined();
});

test('Post detail route uses `sanityFetch` (not raw `client.fetch`)', async () => {
  expect(postDetailRoutePath, 'cannot check fetch helper without the route file').not.toBeUndefined();
  const content = (await readFile(postDetailRoutePath!))!;

  // Every other page in the template fetches via `sanityFetch` from
  // `@/sanity/lib/live`. Using the bare client bypasses Live Content / Draft
  // Mode and breaks Visual Editing.
  expect(content, 'expected the route to import `sanityFetch` (so Live Content + Draft Mode work)').toMatch(
    /\bsanityFetch\b/,
  );
});

test('Post detail route imports `postQuery` and the slugs query', async () => {
  expect(postDetailRoutePath, 'cannot check imports without the route file').not.toBeUndefined();
  expect(postQueryModule, 'cannot check imports without the post query module').not.toBeUndefined();
  expect(postSlugsModule, 'cannot check imports without the slugs query module').not.toBeUndefined();
  const content = (await readFile(postDetailRoutePath!))!;
  const postExport = postQueryModule!.exportName;
  expect(content, `expected the route to import the post query (\`${postExport}\`)`).toMatch(
    new RegExp(`\\b${postExport}\\b`),
  );
  const slugsExport = postSlugsModule!.exportName;
  expect(
    content,
    `expected the route to import the slugs-only query (\`${slugsExport}\`) for \`generateStaticParams\``,
  ).toMatch(new RegExp(`\\b${slugsExport}\\b`));
});

test('Post detail route exports `generateStaticParams` configured with `perspective: "published"` and `stega: false`', async () => {
  expect(postDetailRoutePath, 'cannot check static params without the route file').not.toBeUndefined();
  const content = (await readFile(postDetailRoutePath!))!;
  expect(content, 'expected the route to export `generateStaticParams`').toMatch(
    /export\s+(async\s+)?function\s+generateStaticParams\b/,
  );
  // Without `perspective: 'published'`, draft documents leak into the static
  // params; without `stega: false`, every prerendered URL contains stega tags.
  expect(
    content,
    'expected `generateStaticParams` to use `perspective: "published"` so drafts don\'t produce static routes',
  ).toMatch(/perspective\s*:\s*['"]published['"]/);
  expect(
    content,
    "expected `generateStaticParams` to pass `stega: false` so prerendered slugs aren't stega-encoded",
  ).toMatch(/stega\s*:\s*false/);
});

test('Post detail route handles missing posts via `notFound()`', async () => {
  expect(postDetailRoutePath, 'cannot check notFound usage without the route file').not.toBeUndefined();
  const content = (await readFile(postDetailRoutePath!))!;
  // Otherwise hitting `/posts/does-not-exist` renders an empty/broken page
  // instead of returning a real 404.
  expect(content, 'expected the route to import `notFound` from `next/navigation`').toMatch(
    /from\s+['"]next\/navigation['"]/,
  );
  expect(content, 'expected the route to call `notFound()` when the post is missing').toMatch(/notFound\s*\(\s*\)/);
});

test('Post detail route renders the existing `PortableText` and `Avatar` components', async () => {
  expect(postDetailRoutePath, 'cannot check component usage without the route file').not.toBeUndefined();
  const content = (await readFile(postDetailRoutePath!))!;

  // The template ships these specifically for blog post rendering — the
  // agent shouldn't reinvent them inline. The default exports use whatever
  // local binding the importer picks (e.g. `CustomPortableText`), so we
  // resolve the binding from the import statement and then check that name
  // is used as a JSX tag.
  function findDefaultImportBinding(modulePath: RegExp): string | undefined {
    const importRe = new RegExp(`import\\s+(\\w+)\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s+['"]${modulePath.source}['"]`);
    return content.match(importRe)?.[1];
  }

  const portableTextBinding = findDefaultImportBinding(/(?:@\/app|\.\.?(?:\/[^'"\s]*)*)\/components\/PortableText/);
  expect(
    portableTextBinding,
    'expected the route to import the default export from `@/app/components/PortableText` (the project ships `CustomPortableText` here for blog rendering)',
  ).toBeDefined();
  expect(content, `expected the route to render <${portableTextBinding} ... /> for the post body`).toMatch(
    new RegExp(`<${portableTextBinding}\\b`),
  );

  const avatarBinding = findDefaultImportBinding(/(?:@\/app|\.\.?(?:\/[^'"\s]*)*)\/components\/Avatar/);
  expect(avatarBinding, 'expected the route to import the default export from `@/app/components/Avatar`').toBeDefined();
  expect(content, `expected the route to render <${avatarBinding} ... /> for the post author`).toMatch(
    new RegExp(`<${avatarBinding}\\b`),
  );
});

test('Frontend type-checks cleanly after the agent rebuilds the post page', () => {
  // Final acceptance gate: once the route + queries are wired up, the
  // frontend should compile without errors. The fixture leaves
  // `app/sitemap.ts` referencing post URLs, so a partial implementation
  // that only adds the route without restoring `postQuery` will still type-
  // check, but it won't pass the earlier assertions.
  execSync('npm run type-check --workspace=frontend', { stdio: 'pipe' });
});
