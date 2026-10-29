import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// This eval checks that the agent added Live Content to a small Next.js app:
// a `defineLive` utility with a server token, the posts page fetching through
// the `sanityFetch` it returns, and `<SanityLive />` rendered in the root layout.
//
// The checks ask the TypeScript checker what each call and JSX tag resolves to,
// so a comment, an unused import or a renamed plain-client fetch can't satisfy
// them, while any file name or import alias the agent picks is accepted.

const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'];
const SRC = path.resolve('src') + path.sep;

async function glob(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of fs.glob(pattern, { exclude: EXCLUDE })) out.push(path.resolve(f));
  return out;
}

// The project's own tsconfig plus every source file we inspect, so a narrower
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

const program = createProgram('.', await glob('src/**/*.{ts,tsx,js,jsx}'));
const checker = program.getTypeChecker();
const srcFiles = program.getSourceFiles().filter((sf) => path.resolve(sf.fileName).startsWith(SRC));
const sourceFile = (p: string) => program.getSourceFile(path.resolve(p));

function each(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => each(c, fn));
}
function callsIn(sf: ts.SourceFile, pred: (c: ts.CallExpression) => boolean): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  each(sf, (n) => {
    if (ts.isCallExpression(n) && pred(n)) out.push(n);
  });
  return out;
}
const inPackage = (decl: ts.Node | undefined, pkg: string) =>
  !!decl && decl.getSourceFile().fileName.includes(`/node_modules/${pkg}/`);

// The declaration a name finally refers to, following imports and re-exports.
function resolvedSymbol(node: ts.Node): ts.Symbol | undefined {
  let s = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
  while (s && s.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(s);
    if (next === s) break;
    s = next;
  }
  return s;
}
// True when a call's callee is the named export of a package, however it was imported or renamed.
const callsExport = (c: ts.CallExpression, pkg: string, name: string) => {
  const s = resolvedSymbol(c.expression);
  return !!s && s.getName() === name && (s.declarations ?? []).some((d) => inPackage(d, pkg));
};
// The object literal an expression is, or that a local constant is initialised with.
function objectOf(e: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  if (e && ts.isObjectLiteralExpression(e)) return e;
  const d = e && ts.isIdentifier(e) ? resolvedSymbol(e)?.valueDeclaration : undefined;
  return d && ts.isVariableDeclaration(d) && d.initializer && ts.isObjectLiteralExpression(d.initializer)
    ? d.initializer
    : undefined;
}
const hasProp = (o: ts.ObjectLiteralExpression | undefined, name: string) =>
  !!o?.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);

// Local modules a file imports, transitively, so a page may fetch through its own helper.
function localClosure(entry: string): ts.SourceFile[] {
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
      if (r && !r.isExternalLibraryImport && path.resolve(r.resolvedFileName).startsWith(SRC)) {
        stack.push(path.resolve(r.resolvedFileName));
      }
    }
  }
  return out;
}

// `sanityFetch` is typed by next-sanity as `DefinedFetchType`; the plain client's
// fetch is a method declared by @sanity/client.
const isLiveFetch = (c: ts.CallExpression) => {
  const d = checker.getResolvedSignature(c)?.declaration;
  return (
    inPackage(d, 'next-sanity') &&
    !!d &&
    ts.isTypeAliasDeclaration(d.parent) &&
    d.parent.name.text === 'DefinedFetchType'
  );
};
const isClientFetch = (c: ts.CallExpression) => {
  const d = checker.getResolvedSignature(c)?.declaration;
  const name = d && 'name' in d ? d.name : undefined;
  return inPackage(d, '@sanity/client') && !!name && ts.isIdentifier(name) && name.text === 'fetch';
};

const defineLiveCalls = srcFiles.flatMap((sf) => callsIn(sf, (c) => callsExport(c, 'next-sanity', 'defineLive')));

test('a `defineLive` utility from next-sanity configures a server token', () => {
  expect(
    defineLiveCalls.length,
    'expected `defineLive` from `next-sanity/live` to be called under src/',
  ).toBeGreaterThan(0);
  expect(
    defineLiveCalls.some((c) => hasProp(objectOf(c.arguments[0]), 'serverToken')),
    'expected `defineLive({..., serverToken})`',
  ).toBe(true);
});

test('posts page fetches with `sanityFetch` instead of client.fetch', () => {
  const page = sourceFile('src/app/posts/page.tsx');
  expect(page, 'expected src/app/posts/page.tsx').toBeDefined();
  expect(
    localClosure(page!.fileName).some((sf) => callsIn(sf, isLiveFetch).length > 0),
    'expected the posts page (or a local module it imports) to call the `sanityFetch` returned by `defineLive`',
  ).toBe(true);
  expect(callsIn(page!, isClientFetch).length, 'expected the posts page not to call the plain client `fetch`').toBe(0);
});

test('root layout renders `<SanityLive />`', () => {
  const layout = sourceFile('src/app/layout.tsx');
  expect(layout, 'expected src/app/layout.tsx').toBeDefined();
  let rendered = false;
  each(layout!, (n) => {
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      checker.typeToString(checker.getTypeAtLocation(n.tagName)).includes('DefinedLiveProps')
    )
      rendered = true;
  });
  expect(rendered, 'expected the root layout to render the `SanityLive` component returned by `defineLive`').toBe(true);
});
