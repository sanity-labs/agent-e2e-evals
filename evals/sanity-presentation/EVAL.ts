import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// This eval checks that the agent set up the Sanity Presentation Tool for
// Visual Editing in a Next.js + Sanity workspace. The fixture is the official
// `sanity-io/sanity-template-nextjs-clean` template with all presentation-
// related code surgically removed. A correct solution registers the Studio
// `presentationTool` plugin with a Draft Mode enable path, exposes that route
// with `defineEnableDraftMode`, renders `<VisualEditing />` behind Draft Mode
// and gives the Sanity client a stega Studio URL.
//
// The checks ask the TypeScript checker what each call and JSX tag resolves to,
// so a comment, a local stub with the same name or an unregistered plugin can't
// satisfy them, while any file layout, import alias or constant is accepted.

const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'];

async function glob(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of fs.glob(pattern, { exclude: EXCLUDE })) out.push(path.resolve(f));
  return out;
}

// A package's own tsconfig plus every source file we inspect, so a narrower
// `include` can't hide a file from the checks.
function createProgram(dir: string, extra: string[]): ts.Program {
  const read = ts.readConfigFile(path.resolve(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.resolve(dir));
  return ts.createProgram([...new Set([...parsed.fileNames, ...extra])], {
    ...parsed.options,
    noEmit: true,
    incremental: false,
  });
}

function each(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => each(c, fn));
}
const inPackage = (decl: ts.Node | undefined, pkg: string) =>
  !!decl && decl.getSourceFile().fileName.includes(`/node_modules/${pkg}/`);

function helpers(program: ts.Program) {
  const checker = program.getTypeChecker();
  // The declaration a name finally refers to, following imports and re-exports.
  const resolved = (node: ts.Node): ts.Symbol | undefined => {
    let s = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    while (s && s.flags & ts.SymbolFlags.Alias) {
      const next = checker.getAliasedSymbol(s);
      if (next === s) break;
      s = next;
    }
    return s;
  };
  // True when a node names the export `name` of package `pkg`, however it was imported or renamed.
  const isExport = (node: ts.Node, pkg: string, name: string) => {
    const s = resolved(node);
    return !!s && s.getName() === name && (s.declarations ?? []).some((d) => inPackage(d, pkg));
  };
  const calls = (sf: ts.SourceFile, pkg: string, name: string) => {
    const out: ts.CallExpression[] = [];
    each(sf, (n) => {
      if (ts.isCallExpression(n) && isExport(n.expression, pkg, name)) out.push(n);
    });
    return out;
  };
  // Follow a local constant to its initializer.
  const valueOf = (e: ts.Expression | undefined): ts.Expression | undefined => {
    const d = e && ts.isIdentifier(e) ? resolved(e)?.valueDeclaration : undefined;
    return d && ts.isVariableDeclaration(d) && d.initializer ? d.initializer : e;
  };
  const prop = (e: ts.Expression | undefined, name: string): ts.Expression | undefined => {
    const o = valueOf(e);
    if (!o || !ts.isObjectLiteralExpression(o)) return undefined;
    for (const p of o.properties) {
      if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || p.name.text !== name) continue;
      if (ts.isPropertyAssignment(p)) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p)) return p.name;
    }
    return undefined;
  };
  // The compile-time string value of an expression (a literal or a `const`).
  const stringValue = (e: ts.Expression | undefined) => {
    if (!e) return undefined;
    const t = checker.getTypeAtLocation(e);
    return t.isStringLiteral() ? t.value : undefined;
  };
  return { checker, resolved, isExport, calls, valueOf, prop, stringValue };
}

// Local modules a file imports, transitively, so work moved into a component still counts.
function localClosure(program: ts.Program, entry: string, root: string): ts.SourceFile[] {
  const seen = new Set<string>();
  const out: ts.SourceFile[] = [];
  const stack = [path.resolve(entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    out.push(sf);
    for (const st of sf.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st))) continue;
      if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const r = ts.resolveModuleName(st.moduleSpecifier.text, f, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (r && !r.isExternalLibraryImport && path.resolve(r.resolvedFileName).startsWith(root)) {
        stack.push(path.resolve(r.resolvedFileName));
      }
    }
  }
  return out;
}

const studioConfigPath =
  (await glob('studio/sanity.config.{ts,tsx,js,jsx}'))[0] ?? (await glob('sanity.config.{ts,tsx,js,jsx}'))[0];
const studioDir = studioConfigPath ? path.dirname(studioConfigPath) : path.resolve('studio');
const studio = createProgram(studioDir, studioConfigPath ? [studioConfigPath] : []);
const S = helpers(studio);

const FRONTEND = path.resolve('frontend') + path.sep;
const frontendFiles = await glob('frontend/**/*.{ts,tsx,js,jsx}');
const frontend = createProgram('frontend', frontendFiles);
const F = helpers(frontend);
const frontendSources = frontend.getSourceFiles().filter((sf) => path.resolve(sf.fileName).startsWith(FRONTEND));
const layoutPath = frontendSources
  .map((sf) => sf.fileName)
  .find((f) => ['tsx', 'jsx', 'ts', 'js'].some((x) => f === path.resolve(`frontend/app/layout.${x}`)));

// The `presentationTool({...})` call that is actually in the Studio's `plugins` array.
function registeredPresentationTool(): ts.CallExpression | undefined {
  const sf = studioConfigPath ? studio.getSourceFile(studioConfigPath) : undefined;
  if (!sf) return undefined;
  for (const config of S.calls(sf, 'sanity', 'defineConfig')) {
    const workspaces = S.valueOf(config.arguments[0]);
    const list = workspaces && ts.isArrayLiteralExpression(workspaces) ? workspaces.elements : [workspaces];
    for (const ws of list) {
      const plugins = S.valueOf(S.prop(ws as ts.Expression, 'plugins'));
      if (!plugins || !ts.isArrayLiteralExpression(plugins)) continue;
      for (const el of plugins.elements) {
        const call = S.valueOf(el);
        if (call && ts.isCallExpression(call) && S.isExport(call.expression, 'sanity', 'presentationTool')) return call;
      }
    }
  }
  return undefined;
}
const presentation = registeredPresentationTool();
const previewUrl = presentation ? S.prop(presentation.arguments[0], 'previewUrl') : undefined;
const enablePath = S.stringValue(
  S.prop(S.prop(previewUrl, 'previewMode'), 'enable') ?? S.prop(S.prop(previewUrl, 'draftMode'), 'enable'),
);

// Route handlers that export the GET built by next-sanity's `defineEnableDraftMode`.
const enableRoutes = frontendSources
  .filter((sf) => /\/app\/(.+\/)?route\.(ts|tsx|js|jsx)$/.test(sf.fileName))
  .filter((sf) => F.calls(sf, 'next-sanity', 'defineEnableDraftMode').length > 0)
  .map(
    (sf) =>
      // `frontend/app/(group)/api/draft-mode/enable/route.ts` -> `/api/draft-mode/enable`
      '/' +
      path
        .relative(path.resolve('frontend/app'), sf.fileName)
        .split(path.sep)
        .slice(0, -1)
        .filter((seg) => !/^\(.*\)$/.test(seg))
        .join('/'),
  );

test('Studio config registers the `presentationTool` plugin', () => {
  expect(studioConfigPath, 'expected a `sanity.config.{ts,js}` in studio or repo root').toBeDefined();
  expect(
    presentation,
    'expected `presentationTool(...)` from `sanity/presentation` in the `plugins` array of `defineConfig`',
  ).toBeDefined();
});

test('Studio presentation config wires a `previewUrl` with a Draft Mode enable path', () => {
  expect(previewUrl, 'expected a `previewUrl` option on `presentationTool`').toBeDefined();
  expect(
    enablePath,
    'expected `previewUrl.previewMode.enable` (or `previewUrl.draftMode.enable`) to be a path string or constant',
  ).toMatch(/^\//);
});

test('Frontend exposes a Draft Mode enable route for Presentation', () => {
  expect(
    enableRoutes.length,
    'expected a route handler under `frontend/app/**/route.{ts,tsx}` built with `defineEnableDraftMode` from `next-sanity/draft-mode`',
  ).toBeGreaterThan(0);
});

test('Studio `previewMode.enable` path matches the frontend Draft Mode route', () => {
  expect(enablePath).toBeDefined();
  expect(
    enableRoutes,
    `studio enables draft mode via \`${enablePath}\`, but the frontend routes are ${JSON.stringify(enableRoutes)}`,
  ).toContain(enablePath);
});

test('Frontend layout renders `<VisualEditing />` when Draft Mode is enabled', () => {
  const layout = layoutPath;
  expect(layout, 'expected a `frontend/app/layout.{ts,tsx,js,jsx}`').toBeDefined();
  // The layout itself or a local component it imports renders next-sanity's VisualEditing
  // in a file that also reads Next.js `draftMode()`.
  const gated = localClosure(frontend, layout!, FRONTEND).some((sf) => {
    let renders = false;
    each(sf, (n) => {
      if (
        (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
        F.isExport(n.tagName, 'next-sanity', 'VisualEditing')
      )
        renders = true;
    });
    return renders && F.calls(sf, 'next', 'draftMode').length > 0;
  });
  expect(
    gated,
    'expected `<VisualEditing />` from `next-sanity/visual-editing`, gated on `draftMode()` from `next/headers`',
  ).toBe(true);
});

test('Sanity client is configured with a stega Studio URL for Visual Editing overlays', () => {
  // `defineLive` encodes stega only when its client has `stega.studioUrl`.
  const configs = frontendSources.flatMap((sf) => {
    const out: ts.Expression[] = [];
    each(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const isCreate =
        F.isExport(n.expression, 'next-sanity', 'createClient') ||
        F.isExport(n.expression, '@sanity/client', 'createClient');
      const isWithConfig =
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'withConfig' &&
        inPackage(F.checker.getResolvedSignature(n)?.declaration, '@sanity/client');
      if ((isCreate || isWithConfig) && n.arguments[0]) out.push(n.arguments[0]);
    });
    return out;
  });
  const hasStudioUrl = configs.some((c) => {
    const stega = F.valueOf(F.prop(c, 'stega'));
    return !!stega && ts.isObjectLiteralExpression(stega) && F.prop(stega, 'studioUrl') !== undefined;
  });
  expect(
    hasStudioUrl,
    'expected the Sanity client to pass `stega: {studioUrl}` (in `createClient` or `client.withConfig`)',
  ).toBe(true);
});
