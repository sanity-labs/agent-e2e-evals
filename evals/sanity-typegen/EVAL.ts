import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Every test here decides the result, together with the task's typecheck script.
// The CLI lets callers choose the TypeGen output path, so the generated file is
// found by its characteristic `*QueryResult` exports rather than by name.

async function findGeneratedTypesFile(): Promise<string | undefined> {
  const signature = /export type \w+QueryResult\b/;
  for await (const filePath of fs.glob('frontend/**/*.{ts,tsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    if (signature.test(await fs.readFile(filePath, 'utf-8'))) return filePath;
  }
  return undefined;
}

const frontendTypesPath = await findGeneratedTypesFile();

test('generated types include schema types and at least one GROQ query result', async () => {
  expect(frontendTypesPath, 'expected a TypeGen output file under frontend/').not.toBeUndefined();
  const content = await fs.readFile(frontendTypesPath!, 'utf-8');
  for (const typeName of ['Post', 'Page', 'Person', 'Settings']) {
    expect(content, `expected \`export type ${typeName}\` in generated types`).toMatch(
      new RegExp(`export type ${typeName}\\b`),
    );
  }
});

// The fixture types Sanity data as `any` in these files; the task is to replace that.
const seededAnyFiles = [
  'frontend/app/components/Posts.tsx',
  'frontend/app/components/InfoSection.tsx',
  'frontend/app/components/PageBuilder.tsx',
  'frontend/sanity/lib/types.ts',
  'frontend/sanity/lib/utils.ts',
];

test('no declaration in the seeded files resolves to `any`', () => {
  // The seeded files are the program roots, so the agent's tsconfig `include` can't drop them.
  const frontendDir = path.resolve('frontend');
  const { config, error } = ts.readConfigFile(path.join(frontendDir, 'tsconfig.json'), ts.sys.readFile);
  expect(error, 'frontend/tsconfig.json must be readable').toBeUndefined();
  const { options, errors } = ts.parseJsonConfigFileContent(config, ts.sys, frontendDir);
  expect(errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('\n')).toBe('');

  const program = ts.createProgram(
    seededAnyFiles.map((f) => path.resolve(f)),
    { ...options, noEmit: true },
  );
  const checker = program.getTypeChecker();
  const isAny = (type: ts.Type): boolean =>
    (type.flags & ts.TypeFlags.Any) !== 0 ||
    (checker.isArrayType(type) && checker.getTypeArguments(type as ts.TypeReference).some(isAny));

  const untyped: string[] = [];
  for (const file of seededAnyFiles) {
    const source = program.getSourceFile(path.resolve(file));
    expect(source, `expected ${file} to still exist`).not.toBeUndefined();
    const visit = (node: ts.Node) => {
      const named =
        ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isPropertySignature(node) ||
        ts.isTypeAliasDeclaration(node);
      if (named && isAny(checker.getTypeAtLocation(node.name))) {
        const { line } = source!.getLineAndCharacterOfPosition(node.getStart());
        untyped.push(`${file}:${line + 1} ${node.name.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source!);
  }
  expect(untyped.join('\n'), 'these declarations are still `any`, directly or through an alias').toBe('');
});
