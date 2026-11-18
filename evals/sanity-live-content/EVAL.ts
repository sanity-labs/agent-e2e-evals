import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Structural diagnostics for the Live Content task. Each check asks the
// TypeScript checker what a call or JSX tag resolves to, so comments, fake
// imports and local look-alikes don't count. They show that next-sanity's Live
// Content pieces are present under src/, NOT that they are connected or that
// live content works. Task completion comes from a manual label; until then the
// exporter reports it as unknown.

const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/.git/**'];
const SRC = path.resolve('src') + path.sep;

const files: string[] = [];
for await (const file of fs.glob('src/**/*.{ts,tsx,js,jsx}', { exclude: EXCLUDE })) files.push(path.resolve(file));
const read = ts.readConfigFile(path.resolve('tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.resolve('.'));
const program = ts.createProgram([...new Set([...parsed.fileNames, ...files])], {
  ...parsed.options,
  noEmit: true,
  incremental: false,
});
const checker = program.getTypeChecker();
const nodes: ts.Node[] = [];
const walk = (node: ts.Node): void => {
  nodes.push(node);
  ts.forEachChild(node, walk);
};
for (const sourceFile of program.getSourceFiles())
  if (path.resolve(sourceFile.fileName).startsWith(SRC)) walk(sourceFile);

const inPackage = (declaration: ts.Node | undefined, packageName: string) =>
  !!declaration && declaration.getSourceFile().fileName.includes(`/node_modules/${packageName}/`);
// The declaration a name finally refers to, following imports and re-exports.
function resolved(node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(symbol);
    if (next === symbol) break;
    symbol = next;
  }
  return symbol;
}
const calls = nodes.filter(ts.isCallExpression);

test('calls `defineLive` from next-sanity with a `serverToken` option', () => {
  const defineLive = calls.filter((call) => {
    const symbol = resolved(call.expression);
    return (
      symbol?.getName() === 'defineLive' &&
      (symbol.declarations ?? []).some((declaration) => inPackage(declaration, 'next-sanity'))
    );
  });
  expect(defineLive.length, 'expected a `defineLive` call from `next-sanity/live` under src/').toBeGreaterThan(0);
  const options = defineLive.map((call) => {
    const argument = call.arguments[0];
    const declaration = argument && ts.isIdentifier(argument) ? resolved(argument)?.valueDeclaration : undefined;
    return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : argument;
  });
  expect(
    options.some(
      (option) =>
        !!option &&
        ts.isObjectLiteralExpression(option) &&
        option.properties.some((property) => property.name?.getText() === 'serverToken'),
    ),
    'expected `defineLive({..., serverToken})`',
  ).toBe(true);
});

// `defineLive` returns `sanityFetch` typed `DefinedFetchType` and `SanityLive` typed with `DefinedLiveProps`.
test('calls a function typed as the `sanityFetch` that `defineLive` returns', () => {
  const live = calls.some((call) => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    return (
      inPackage(declaration, 'next-sanity') &&
      !!declaration &&
      ts.isTypeAliasDeclaration(declaration.parent) &&
      declaration.parent.name.text === 'DefinedFetchType'
    );
  });
  expect(live, 'expected a call under src/ to a function typed `DefinedFetchType` by next-sanity').toBe(true);
});

test('contains JSX for a component typed as the `SanityLive` that `defineLive` returns', () => {
  const present = nodes.some(
    (node) =>
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      checker.typeToString(checker.getTypeAtLocation(node.tagName)).includes('DefinedLiveProps'),
  );
  expect(present, 'expected JSX under src/ for a component typed with next-sanity `DefinedLiveProps`').toBe(true);
});
