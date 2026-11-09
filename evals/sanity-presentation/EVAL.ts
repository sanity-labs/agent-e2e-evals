import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Structural diagnostics for the Presentation / Visual Editing task. The fixture
// is the official `sanity-io/sanity-template-nextjs-clean` template with the
// presentation code removed. Each check asks the TypeScript checker what a call
// or JSX tag resolves to, so comments, fake imports and local look-alikes don't
// count. They show that the required SDK pieces are present, NOT that they are
// connected or that Visual Editing works. Task completion comes from a manual
// label; until then the exporter reports it as unknown
// (research/presentation-live-contract.md).

const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'];

async function glob(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of fs.glob(pattern, { exclude: EXCLUDE })) out.push(path.resolve(f));
  return out;
}

// One package's program and lookup helpers. Every file under `dir` is included,
// so a narrower tsconfig `include` can't hide a file from the checks.
function analyse(dir: string, files: string[]) {
  const read = ts.readConfigFile(path.resolve(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.resolve(dir));
  const program = ts.createProgram([...new Set([...parsed.fileNames, ...files])], {
    ...parsed.options,
    noEmit: true,
    incremental: false,
  });
  const checker = program.getTypeChecker();
  const root = path.resolve(dir) + path.sep;
  const nodes: Array<[ts.SourceFile, ts.Node]> = [];
  for (const sf of program.getSourceFiles()) {
    if (!path.resolve(sf.fileName).startsWith(root)) continue;
    const walk = (n: ts.Node): void => {
      nodes.push([sf, n]);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
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
    return (
      s?.getName() === name &&
      (s.declarations ?? []).some((d) => d.getSourceFile().fileName.includes(`/node_modules/${pkg}/`))
    );
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
      if (p.name?.getText().replace(/['"]/g, '') !== name) continue;
      if (ts.isPropertyAssignment(p)) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p)) return p.name;
    }
    return undefined;
  };
  return { checker, nodes, isExport, valueOf, prop };
}

const studioConfigPath =
  (await glob('studio/sanity.config.{ts,tsx,js,jsx}'))[0] ?? (await glob('sanity.config.{ts,tsx,js,jsx}'))[0];
const studioDir = studioConfigPath ? path.dirname(studioConfigPath) : path.resolve('studio');
const S = analyse(studioDir, studioConfigPath ? [studioConfigPath] : []);
const F = analyse('frontend', await glob('frontend/**/*.{ts,tsx,js,jsx}'));

// A `presentationTool({...})` call placed in the `plugins` array of the Studio's `defineConfig`.
const presentation = S.nodes
  .filter(
    ([sf, n]) =>
      sf.fileName === studioConfigPath && ts.isCallExpression(n) && S.isExport(n.expression, 'sanity', 'defineConfig'),
  )
  .flatMap(([, n]) => {
    const ws = S.valueOf((n as ts.CallExpression).arguments[0]);
    return ws && ts.isArrayLiteralExpression(ws) ? [...ws.elements] : [ws];
  })
  .flatMap((ws) => {
    const plugins = S.valueOf(S.prop(ws as ts.Expression, 'plugins'));
    return plugins && ts.isArrayLiteralExpression(plugins) ? plugins.elements.map((e) => S.valueOf(e)) : [];
  })
  .find(
    (c): c is ts.CallExpression =>
      !!c && ts.isCallExpression(c) && S.isExport(c.expression, 'sanity', 'presentationTool'),
  );
const previewUrl = presentation ? S.prop(presentation.arguments[0], 'previewUrl') : undefined;
const enableExpr =
  S.prop(S.prop(previewUrl, 'previewMode'), 'enable') ?? S.prop(S.prop(previewUrl, 'draftMode'), 'enable');
const enableType = enableExpr && S.checker.getTypeAtLocation(enableExpr);
const enablePath = enableType?.isStringLiteral() ? enableType.value : undefined;

const callsTo = (pkg: string, name: string) =>
  F.nodes.filter(([, n]) => ts.isCallExpression(n) && F.isExport(n.expression, pkg, name));

test('Studio `defineConfig` lists a `presentationTool` call in `plugins`', () => {
  expect(studioConfigPath, 'expected a `sanity.config.{ts,js}` in studio or repo root').toBeDefined();
  expect(presentation, 'expected `presentationTool(...)` from `sanity/presentation` in `plugins`').toBeDefined();
});

test('`presentationTool` has a `previewUrl` with a Draft Mode enable path', () => {
  expect(previewUrl, 'expected a `previewUrl` option on `presentationTool`').toBeDefined();
  expect(enablePath, 'expected `previewUrl.previewMode.enable` to be a path string or constant').toMatch(/^\//);
});

test('a route file at the Studio enable path calls `defineEnableDraftMode`', () => {
  // `frontend/app/(group)/api/draft-mode/enable/route.ts` -> `/api/draft-mode/enable`
  const routes = callsTo('next-sanity', 'defineEnableDraftMode')
    .map(([sf]) => path.relative(path.resolve('frontend/app'), sf.fileName).split(path.sep))
    .filter((segs) => /^route\.(ts|tsx|js|jsx)$/.test(segs.at(-1)!) && segs[0] !== '..')
    .map(
      (segs) =>
        '/' +
        segs
          .slice(0, -1)
          .filter((s) => !/^\(.*\)$/.test(s))
          .join('/'),
    );
  expect(routes, `expected a frontend/app route.ts calling \`defineEnableDraftMode\` at \`${enablePath}\``).toContain(
    enablePath,
  );
});

test('frontend contains JSX for `<VisualEditing />` from next-sanity', () => {
  const present = F.nodes.some(
    ([, n]) =>
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      F.isExport(n.tagName, 'next-sanity', 'VisualEditing'),
  );
  expect(present, 'expected JSX for `VisualEditing` from `next-sanity/visual-editing`').toBe(true);
});

test('a Sanity client config sets `stega.studioUrl`', () => {
  const configs = F.nodes.flatMap(([, n]) => {
    if (!ts.isCallExpression(n) || !n.arguments[0]) return [];
    const create =
      F.isExport(n.expression, 'next-sanity', 'createClient') ||
      F.isExport(n.expression, '@sanity/client', 'createClient');
    const withConfig =
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'withConfig' &&
      !!F.checker
        .getResolvedSignature(n)
        ?.declaration?.getSourceFile()
        .fileName.includes('/node_modules/@sanity/client/');
    return create || withConfig ? [n.arguments[0]] : [];
  });
  expect(
    configs.some((c) => F.prop(F.prop(c, 'stega'), 'studioUrl') !== undefined),
    'expected `stega: {studioUrl}` in a `createClient` or `client.withConfig` call',
  ).toBe(true);
});
