import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Structural diagnostics for the Live Content task. Each check asks the
// TypeScript checker what a call or JSX tag resolves to, so comments, fake
// imports and local look-alikes don't count. They show that next-sanity's Live
// Content pieces are present under src/, NOT that they are connected or that
// live content works. Task completion comes from a manual label; until then the
// exporter reports it as unknown (research/presentation-live-contract.md).

const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/.git/**'];
const SRC = path.resolve('src') + path.sep;

const files: string[] = [];
for await (const f of fs.glob('src/**/*.{ts,tsx,js,jsx}', { exclude: EXCLUDE })) files.push(path.resolve(f));
const read = ts.readConfigFile(path.resolve('tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.resolve('.'));
const program = ts.createProgram([...new Set([...parsed.fileNames, ...files])], {
  ...parsed.options,
  noEmit: true,
  incremental: false,
});
const checker = program.getTypeChecker();
const nodes: ts.Node[] = [];
const walk = (n: ts.Node): void => {
  nodes.push(n);
  ts.forEachChild(n, walk);
};
for (const sf of program.getSourceFiles()) if (path.resolve(sf.fileName).startsWith(SRC)) walk(sf);

const inPackage = (d: ts.Node | undefined, pkg: string) =>
  !!d && d.getSourceFile().fileName.includes(`/node_modules/${pkg}/`);
// The declaration a name finally refers to, following imports and re-exports.
function resolved(node: ts.Node): ts.Symbol | undefined {
  let s = checker.getSymbolAtLocation(node);
  while (s && s.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(s);
    if (next === s) break;
    s = next;
  }
  return s;
}
const calls = nodes.filter(ts.isCallExpression);

test('calls `defineLive` from next-sanity with a `serverToken` option', () => {
  const defineLive = calls.filter((c) => {
    const s = resolved(c.expression);
    return s?.getName() === 'defineLive' && (s.declarations ?? []).some((d) => inPackage(d, 'next-sanity'));
  });
  expect(defineLive.length, 'expected a `defineLive` call from `next-sanity/live` under src/').toBeGreaterThan(0);
  const options = defineLive.map((c) => {
    const a = c.arguments[0];
    const d = a && ts.isIdentifier(a) ? resolved(a)?.valueDeclaration : undefined;
    return d && ts.isVariableDeclaration(d) ? d.initializer : a;
  });
  expect(
    options.some(
      (o) => !!o && ts.isObjectLiteralExpression(o) && o.properties.some((p) => p.name?.getText() === 'serverToken'),
    ),
    'expected `defineLive({..., serverToken})`',
  ).toBe(true);
});

// `defineLive` returns `sanityFetch` typed `DefinedFetchType` and `SanityLive` typed with `DefinedLiveProps`.
test('calls a function typed as the `sanityFetch` that `defineLive` returns', () => {
  const live = calls.some((c) => {
    const d = checker.getResolvedSignature(c)?.declaration;
    return (
      inPackage(d, 'next-sanity') &&
      !!d &&
      ts.isTypeAliasDeclaration(d.parent) &&
      d.parent.name.text === 'DefinedFetchType'
    );
  });
  expect(live, 'expected a call under src/ to a function typed `DefinedFetchType` by next-sanity').toBe(true);
});

test('contains JSX for a component typed as the `SanityLive` that `defineLive` returns', () => {
  const present = nodes.some(
    (n) =>
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      checker.typeToString(checker.getTypeAtLocation(n.tagName)).includes('DefinedLiveProps'),
  );
  expect(present, 'expected JSX under src/ for a component typed with next-sanity `DefinedLiveProps`').toBe(true);
});
