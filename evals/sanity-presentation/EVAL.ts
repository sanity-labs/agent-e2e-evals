import fs from 'node:fs/promises';
import { expect, test } from 'vitest';

// This eval checks that the agent set up the Sanity Presentation Tool for
// Visual Editing in a Next.js + Sanity workspace. The fixture is the official
// `sanity-io/sanity-template-nextjs-clean` template with all presentation-
// related code surgically removed. A correct solution wires the Studio
// `presentationTool` plugin back up and adds the frontend pieces required for
// Next.js Draft Mode + Visual Editing overlays to work end-to-end.

async function readFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function firstExisting(...paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    if ((await readFile(p)) !== undefined) return p;
  }
  return undefined;
}

// Search common studio/config filenames for the Sanity Studio config.
const studioConfigPath = await firstExisting(
  'studio/sanity.config.ts',
  'studio/sanity.config.js',
  'sanity.config.ts',
  'sanity.config.js',
);

// Search common frontend layout filenames.
const frontendLayoutPath = await firstExisting(
  'frontend/app/layout.tsx',
  'frontend/app/layout.jsx',
  'frontend/app/layout.ts',
  'frontend/app/layout.js',
);

// Locate a Next.js route handler that enables Draft Mode. The template ships
// it at `app/api/draft-mode/enable/route.ts`, but we accept any route.ts under
// `frontend/app` that imports `defineEnableDraftMode`.
async function findEnableDraftModeRoute(): Promise<string | undefined> {
  for await (const filePath of fs.glob('frontend/app/**/route.{ts,tsx,js,jsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    const content = await readFile(filePath);
    if (content && /defineEnableDraftMode\b/.test(content)) return filePath;
  }
  return undefined;
}

const enableDraftModeRoutePath = await findEnableDraftModeRoute();

const frontendClientPath = await firstExisting(
  'frontend/sanity/lib/client.ts',
  'frontend/sanity/lib/client.js',
  'frontend/src/sanity/lib/client.ts',
);

test('Studio config registers the `presentationTool` plugin', async () => {
  expect(studioConfigPath, 'expected a `sanity.config.{ts,js}` in studio or repo root').not.toBeUndefined();
  const content = (await readFile(studioConfigPath!))!;

  expect(content, 'expected an import from `sanity/presentation`').toMatch(/from\s+['"]sanity\/presentation['"]/);
  expect(content, 'expected `presentationTool` to be imported').toMatch(/\bpresentationTool\b/);
  expect(content, 'expected `presentationTool({...})` to be called inside the `plugins` array').toMatch(
    /presentationTool\s*\(/,
  );
});

test('Studio presentation config wires a `previewUrl` pointing at the Next.js app', async () => {
  expect(studioConfigPath).not.toBeUndefined();
  const content = (await readFile(studioConfigPath!))!;

  expect(content, 'expected a `previewUrl` option on `presentationTool`').toMatch(/previewUrl\s*:/);
  // The `previewMode.enable` path is what the Studio calls to enable Next.js
  // Draft Mode — without it, Presentation can't load drafts.
  expect(
    content,
    'expected `previewMode.enable` (or `previewUrl.draftMode.enable`) to reference a Next.js route',
  ).toMatch(/enable\s*:\s*['"]\/[^'"\s]+['"]/);
});

test('Frontend exposes a Draft Mode enable route for Presentation', async () => {
  expect(
    enableDraftModeRoutePath,
    'expected a Next.js route handler under `frontend/app/**/route.{ts,tsx}` that uses `defineEnableDraftMode` from `next-sanity/draft-mode`',
  ).not.toBeUndefined();

  const content = (await readFile(enableDraftModeRoutePath!))!;
  expect(content, 'expected the route to import `defineEnableDraftMode` from `next-sanity/draft-mode`').toMatch(
    /from\s+['"]next-sanity\/draft-mode['"]/,
  );
  expect(content, 'expected the route to export a GET handler via `defineEnableDraftMode(...)`').toMatch(
    /defineEnableDraftMode\s*\(/,
  );
  expect(content, 'expected the route to export a `GET` handler').toMatch(/\bGET\b/);
});

test('Studio `previewMode.enable` path matches the frontend Draft Mode route', async () => {
  // The path the Studio calls to enable Draft Mode must match the actual
  // Next.js route the frontend exposes — otherwise clicking "Presentation"
  // won't activate drafts.
  expect(studioConfigPath).not.toBeUndefined();
  expect(enableDraftModeRoutePath).not.toBeUndefined();

  const configContent = (await readFile(studioConfigPath!))!;
  const enableMatch = configContent.match(/enable\s*:\s*['"](\/[^'"\s]+)['"]/);
  expect(enableMatch, 'could not find an `enable: "/..."` entry in the studio config').not.toBeNull();
  const configuredPath = enableMatch![1]!;

  // Derive the route's URL path from its file path, e.g.
  // `frontend/app/api/draft-mode/enable/route.ts` -> `/api/draft-mode/enable`.
  const routeUrl =
    '/' + enableDraftModeRoutePath!.replace(/^frontend\/app\//, '').replace(/\/route\.(ts|tsx|js|jsx)$/, '');

  expect(
    configuredPath,
    `studio config enables draft mode via \`${configuredPath}\`, but the frontend exposes the route at \`${routeUrl}\``,
  ).toBe(routeUrl);
});

test('Frontend layout renders `<VisualEditing />` when Draft Mode is enabled', async () => {
  expect(frontendLayoutPath, 'expected a `frontend/app/layout.{ts,tsx,js,jsx}`').not.toBeUndefined();
  const content = (await readFile(frontendLayoutPath!))!;

  expect(content, 'expected `VisualEditing` to be imported from `next-sanity/visual-editing`').toMatch(
    /from\s+['"]next-sanity\/visual-editing['"]/,
  );
  expect(content, 'expected `<VisualEditing />` to be rendered in the layout').toMatch(/<VisualEditing\b/);
  // Visual editing should only render inside Draft Mode — otherwise stega
  // encoded strings will leak into production output.
  expect(content, 'expected the layout to gate `<VisualEditing />` on Next.js `draftMode()`').toMatch(/draftMode\s*\(/);
});

test('Sanity client is configured with `stega` for Visual Editing overlays', async () => {
  expect(frontendClientPath, 'expected a Sanity client at `frontend/sanity/lib/client.{ts,js}`').not.toBeUndefined();
  const content = (await readFile(frontendClientPath!))!;

  // `stega` is what lets the Presentation Tool map rendered strings back to
  // their source documents for click-to-edit overlays. Without it, the
  // overlays are inert.
  expect(
    content,
    'expected the Sanity client to pass a `stega` option (e.g. `stega: {studioUrl}`) for Visual Editing',
  ).toMatch(/\bstega\b/);
});
