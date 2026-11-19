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
// label; until then the exporter reports it as unknown.

const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'];

async function glob(pattern: string): Promise<string[]> {
  const filePaths: string[] = [];
  for await (const file of fs.glob(pattern, { exclude: EXCLUDE })) filePaths.push(path.resolve(file));
  return filePaths;
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
  for (const sourceFile of program.getSourceFiles()) {
    if (!path.resolve(sourceFile.fileName).startsWith(root)) continue;
    const walk = (node: ts.Node): void => {
      nodes.push([sourceFile, node]);
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
  }
  // The declaration a name finally refers to, following imports and re-exports.
  const resolved = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      const next = checker.getAliasedSymbol(symbol);
      if (next === symbol) break;
      symbol = next;
    }
    return symbol;
  };
  // True when a node names the export `name` of package `pkg`, however it was imported or renamed.
  const isExport = (node: ts.Node, packageName: string, name: string) => {
    const symbol = resolved(node);
    return (
      symbol?.getName() === name &&
      (symbol.declarations ?? []).some((declaration) =>
        declaration.getSourceFile().fileName.includes(`/node_modules/${packageName}/`),
      )
    );
  };
  // Follow a local constant to its initializer.
  const valueOf = (expression: ts.Expression | undefined): ts.Expression | undefined => {
    const declaration = expression && ts.isIdentifier(expression) ? resolved(expression)?.valueDeclaration : undefined;
    return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? declaration.initializer
      : expression;
  };
  const prop = (expression: ts.Expression | undefined, name: string): ts.Expression | undefined => {
    const object = valueOf(expression);
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    for (const property of object.properties) {
      if (property.name?.getText().replace(/['"]/g, '') !== name) continue;
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property)) return property.name;
    }
    return undefined;
  };
  return { checker, nodes, isExport, valueOf, prop };
}

const studioConfigPath =
  (await glob('studio/sanity.config.{ts,tsx,js,jsx}'))[0] ?? (await glob('sanity.config.{ts,tsx,js,jsx}'))[0];
const studioDir = studioConfigPath ? path.dirname(studioConfigPath) : path.resolve('studio');
const studioAnalysis = analyse(studioDir, studioConfigPath ? [studioConfigPath] : []);
const frontendAnalysis = analyse('frontend', await glob('frontend/**/*.{ts,tsx,js,jsx}'));

// A `presentationTool({...})` call placed in the `plugins` array of the Studio's `defineConfig`.
const presentation = studioAnalysis.nodes
  .filter(
    ([sourceFile, node]) =>
      sourceFile.fileName === studioConfigPath &&
      ts.isCallExpression(node) &&
      studioAnalysis.isExport(node.expression, 'sanity', 'defineConfig'),
  )
  .flatMap(([, node]) => {
    const workspace = studioAnalysis.valueOf((node as ts.CallExpression).arguments[0]);
    return workspace && ts.isArrayLiteralExpression(workspace) ? [...workspace.elements] : [workspace];
  })
  .flatMap((workspace) => {
    const plugins = studioAnalysis.valueOf(studioAnalysis.prop(workspace as ts.Expression, 'plugins'));
    return plugins && ts.isArrayLiteralExpression(plugins)
      ? plugins.elements.map((element) => studioAnalysis.valueOf(element))
      : [];
  })
  .find(
    (call): call is ts.CallExpression =>
      !!call && ts.isCallExpression(call) && studioAnalysis.isExport(call.expression, 'sanity', 'presentationTool'),
  );
const previewUrl = presentation ? studioAnalysis.prop(presentation.arguments[0], 'previewUrl') : undefined;
const enableExpr =
  studioAnalysis.prop(studioAnalysis.prop(previewUrl, 'previewMode'), 'enable') ??
  studioAnalysis.prop(studioAnalysis.prop(previewUrl, 'draftMode'), 'enable');
const enableType = enableExpr && studioAnalysis.checker.getTypeAtLocation(enableExpr);
const enablePath = enableType?.isStringLiteral() ? enableType.value : undefined;

const callsTo = (packageName: string, name: string) =>
  frontendAnalysis.nodes.filter(
    ([, node]) => ts.isCallExpression(node) && frontendAnalysis.isExport(node.expression, packageName, name),
  );

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
    .filter((segments) => /^route\.(ts|tsx|js|jsx)$/.test(segments.at(-1)!) && segments[0] !== '..')
    .map(
      (segs) =>
        '/' +
        segs
          .slice(0, -1)
          .filter((segment) => !/^\(.*\)$/.test(segment))
          .join('/'),
    );
  expect(routes, `expected a frontend/app route.ts calling \`defineEnableDraftMode\` at \`${enablePath}\``).toContain(
    enablePath,
  );
});

test('frontend contains JSX for `<VisualEditing />` from next-sanity', () => {
  const present = frontendAnalysis.nodes.some(
    ([, node]) =>
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      frontendAnalysis.isExport(node.tagName, 'next-sanity', 'VisualEditing'),
  );
  expect(present, 'expected JSX for `VisualEditing` from `next-sanity/visual-editing`').toBe(true);
});

test('a Sanity client config sets `stega.studioUrl`', () => {
  const configs = frontendAnalysis.nodes.flatMap(([, node]) => {
    if (!ts.isCallExpression(node) || !node.arguments[0]) return [];
    const create =
      frontendAnalysis.isExport(node.expression, 'next-sanity', 'createClient') ||
      frontendAnalysis.isExport(node.expression, '@sanity/client', 'createClient');
    const withConfig =
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'withConfig' &&
      !!frontendAnalysis.checker
        .getResolvedSignature(node)
        ?.declaration?.getSourceFile()
        .fileName.includes('/node_modules/@sanity/client/');
    return create || withConfig ? [node.arguments[0]] : [];
  });
  expect(
    configs.some((config) => frontendAnalysis.prop(frontendAnalysis.prop(config, 'stega'), 'studioUrl') !== undefined),
    'expected `stega: {studioUrl}` in a `createClient` or `client.withConfig` call',
  ).toBe(true);
});
