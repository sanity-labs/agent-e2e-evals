import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The pnpm patch stops files the agent writes from steering the grader. These tests run the patched agent-eval code
// with a fake sandbox and the real vitest, so they fail on the unpatched package.
const agents = createRequire(import.meta.url)
  .resolve('@vercel/agent-eval/package.json')
  .replace(/package\.json$/, 'dist/lib/agents/');
const shared = await import(pathToFileURL(join(agents, 'shared.js')).href);
const orchestrator = await import(pathToFileURL(join(agents, 'plugin/orchestrator.js')).href);
const orchestratorVerifier = await import(pathToFileURL(join(agents, 'verifier.js')).href);
const repo = join(import.meta.dirname, '..');
const vitestDir = createRequire(import.meta.url)
  .resolve('vitest/package.json')
  .replace(/\/package\.json$/, '');

type Call = {
  cmd: string;
  args: string[];
  env?: Record<string, string> | undefined;
};
function fakeSandbox(dir: string) {
  const calls: Call[] = [];
  return {
    calls,
    getWorkingDirectory: () => dir,
    runShell: async (script: string) => {
      const result = spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    runCommand: async (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ cmd, args, env: opts?.env });
      const result = spawnSync(cmd, args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...opts?.env },
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    writeFiles: async (files: Record<string, string>) => {
      for (const [filePath, content] of Object.entries(files)) writeFileSync(join(dir, filePath), content);
    },
  };
}

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('grader patch', () => {
  it('a failing EVAL fails even when the agent wrote every known exit-0 vector', async () => {
    dir = mkdtempSync(join(tmpdir(), 'grader-'));
    symlinkSync(join(vitestDir, '..'), join(dir, 'node_modules'));
    writeFileSync(
      join(dir, 'EVAL.ts'),
      "import { test, expect } from 'vitest';\ntest('real', () => expect(1).toBe(2));\n",
    );
    const exit0 = 'if (/vitest/.test(process.argv[1] || "")) process.exit(0);\n';
    writeFileSync(join(dir, 'postcss.config.cjs'), exit0);
    writeFileSync(join(dir, 'evil.cjs'), exit0);
    writeFileSync(join(dir, '.npmrc'), 'node-options=--require ./evil.cjs\n');
    writeFileSync(join(dir, 'fake.cjs'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'c',
        type: 'module',
        bin: { vitest: './fake.cjs' },
      }),
    );
    const sandbox = fakeSandbox(dir);
    await shared.createVitestConfig(sandbox);
    // The helper the shipped config points at is not needed here; drop setupFiles and the alias.
    const config = readFileSync(join(dir, 'vitest.config.ts'), 'utf8')
      .replace(/setupFiles: \[[^\]]*\],/, '')
      .replace(/alias: \{[^}]*\}/, 'alias: {}');
    writeFileSync(join(dir, 'vitest.config.ts'), config);

    const results = await shared.runValidation(sandbox, [], 'vitest', {});

    expect(sandbox.calls.at(-1)).toMatchObject({
      cmd: 'node',
      args: ['node_modules/vitest/vitest.mjs', 'run', 'EVAL.ts'],
    });
    expect(results.test.success).toBe(false);
    expect(results.test.output).toMatch(/1 failed/);
  });

  it('the fallback vitest install runs no lifecycle scripts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'grader-'));
    const sandbox = fakeSandbox(dir);
    sandbox.runCommand = async (cmd, args) => {
      sandbox.calls.push({ cmd, args });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await shared.ensureValidationRunner(sandbox);
    expect(sandbox.calls[0]?.args).toContain('--ignore-scripts');
  });

  it('the verifier installs without scripts, checks packages after install, and keeps the key from non-judge graders', () => {
    const src = readFileSync(join(agents, 'plugin/orchestrator.js'), 'utf8');
    expect(src).toContain('projectInstallSteps(def.install(options)).map(graderInstallStep)');
    expect(src).toContain('await assertRegistryOnly(verifier, workspaces);');
    expect(src).toContain('fixtureUsesJudge(testFiles) ? judgeRuntime.authEnv : {}');
    expect(
      orchestrator.graderInstallStep({
        kind: 'command',
        cmd: 'npm',
        args: ['install'],
      }).args,
    ).toEqual(['install', '--ignore-scripts']);
  });

  const lockfile = (packages: object) => {
    dir = mkdtempSync(join(tmpdir(), 'grader-'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), JSON.stringify({ packages }));
    return fakeSandbox(dir);
  };
  const REGISTRY = 'https://registry.npmjs.org/';
  const reg = (name: string) => ({
    version: '1.0.0',
    resolved: `${REGISTRY}${name}/-/${name.split('/').pop()}-1.0.0.tgz`,
  });
  const studioLinks = {
    studio: { name: 'studio' },
    'node_modules/studio': { resolved: 'studio', link: true },
  };

  it.each([
    ['one registry package', { 'node_modules/x': reg('x') }, 0],
    ['one file dependency', { 'node_modules/x': { resolved: 'file:x' } }, 1],
    [
      'one undeclared alias',
      {
        'node_modules/ui5': {
          name: '@sanity/ui',
          version: '5.0.0-alpha.19',
          resolved: `${REGISTRY}@sanity/ui/-/ui-5.0.0-alpha.19.tgz`,
        },
      },
      1,
    ],
  ])('the serialized validator matches the old validator for %s', async (_, packages, expectedExitCode) => {
    const sandbox = lockfile(packages);
    const oldValidator =
      'const ws=[];const l=require("./node_modules/.package-lock.json");const R="https://registry.npmjs.org/";' +
      'const seg=p=>p.slice(p.lastIndexOf("node_modules/")+13);' +
      'const tgz=(n,v)=>R+n+"/-/"+n.split("/").pop()+"-"+v.version+".tgz";' +
      'const exact=(p,v)=>typeof v.resolved==="string"&&v.resolved===tgz(v.name||seg(p),v);const aliases=new Set();' +
      'for(const[p,v]of Object.entries(l.packages||{}))if(p&&exact(p,v)&&!v.name)' +
      'for(const[d,s]of Object.entries({...v.dependencies,...v.optionalDependencies,...v.peerDependencies}))' +
      'if(String(s).startsWith("npm:"))aliases.add(d+" "+String(s).slice(4).replace(/(.)@.*$/,"$1"));' +
      'const fromRegistry=(p,v)=>exact(p,v)&&(!v.name||v.name===seg(p)||aliases.has(seg(p)+" "+v.name));' +
      'const fromParent=(p,v)=>!!v&&(v.inBundle?' +
      '(i=>i>0&&fromParent(p.slice(0,i),(l.packages||{})[p.slice(0,i)]))(p.lastIndexOf("/node_modules/")):' +
      'fromRegistry(p,v));const ok=(p,v)=>fromParent(p,v)||ws.some(([d,n])=>(p===d&&' +
      '(v.name===n||(v.name===undefined&&d.split("/").pop()===n)))||' +
      '(p==="node_modules/"+n&&v.link===true&&v.resolved===d));' +
      'const bad=Object.entries(l.packages||{}).filter(([p,v])=>p&&!ok(p,v));' +
      'if(bad.length){console.log(bad.slice(0,5).map(([p,v])=>p+" "+(v.resolved||"no resolved")).join("\\n"));' +
      'process.exit(1)}';
    const oldSource = Buffer.from(oldValidator).toString('base64');
    const oldCommand = `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" ${oldSource}`;
    const newCommand = orchestrator.serializedFunctionCommand(orchestrator.validateRegistryPackages, [[]]);
    const [oldResult, newResult] = await Promise.all([sandbox.runShell(oldCommand), sandbox.runShell(newCommand)]);

    expect(oldResult.exitCode).toBe(expectedExitCode);
    expect(newResult.exitCode).toBe(oldResult.exitCode);
  });

  it('refuses to serialize transformed helper source', () => {
    expect(() => orchestrator.serializedFunctionCommand(function __vite_ssr_helper() {})).toThrow(
      'unsafe transformed helper source',
    );
  });

  it('accepts registry packages and the workspace links the fixture ships', async () => {
    const sandbox = lockfile({
      'node_modules/vitest': reg('vitest'),
      'node_modules/x': reg('x'),
      'node_modules/x/node_modules/y': { inBundle: true },
      'node_modules/x/node_modules/y/node_modules/z': { inBundle: true },
      ...studioLinks,
    });
    await expect(orchestrator.assertRegistryOnly(sandbox, [['studio', 'studio']])).resolves.toBeUndefined();
  });

  // Probe's case H-override: the agent deletes vitest and adds a file: override; the fallback vitest install would run
  // after the registry check and honour the override. The grader must refuse before that install.
  it('refuses when the project install left no vitest, and accepts when it did', async () => {
    dir = mkdtempSync(join(tmpdir(), 'grader-'));
    mkdirSync(join(dir, 'node_modules'));
    await expect(orchestrator.assertVitestInstalled(fakeSandbox(dir))).rejects.toThrow(
      /Grader refused: the project install has no vitest/,
    );
    mkdirSync(join(dir, 'node_modules/vitest'));
    writeFileSync(join(dir, 'node_modules/vitest/package.json'), '{"name":"vitest"}');
    await expect(orchestrator.assertVitestInstalled(fakeSandbox(dir))).resolves.toBeUndefined();
  });

  it('checks for vitest right after the registry check, before anything can install it', () => {
    const src = readFileSync(join(agents, 'plugin/orchestrator.js'), 'utf8');
    expect(src).toContain(
      'await assertRegistryOnly(verifier, workspaces);\n        await assertVitestInstalled(verifier);',
    );
  });

  // The shapes npm 11 writes for the TypeGen fixture (workspaces studio and frontend): a folder entry has no name
  // when the package name equals the folder name. Found by Probe's cross-test and the OpenRouter-lane smoke.
  it('accepts workspace folder entries npm writes without a name', async () => {
    const sandbox = lockfile({
      frontend: { dependencies: { next: '16.0.0' } },
      studio: { version: '1.0.0', dependencies: { sanity: '5.0.0' } },
      'node_modules/frontend': { resolved: 'frontend', link: true },
      'node_modules/studio': { resolved: 'studio', link: true },
      'node_modules/next': reg('next'),
    });
    await expect(
      orchestrator.assertRegistryOnly(sandbox, [
        ['studio', 'studio'],
        ['frontend', 'frontend'],
      ]),
    ).resolves.toBeUndefined();
  });

  // Every fixture's shipped lock must pass as it is, including the npm: aliases that registry packages declare
  // (sanity's ui5, @typescript/typescript6's @typescript/old, @isaacs/cliui's *-cjs).
  it.each(
    readdirSync(join(repo, 'evals')).filter((fixtureName) =>
      existsSync(join(repo, 'evals', fixtureName, 'npm-shrinkwrap.json')),
    ),
  )('accepts the lock the %s fixture ships', async (fixture) => {
    const lock = JSON.parse(readFileSync(join(repo, 'evals', fixture, 'npm-shrinkwrap.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(repo, 'evals', fixture, 'package.json'), 'utf8'));
    const ws = []
      .concat(pkg.workspaces || [])
      .map((workspace: string) => [
        workspace,
        JSON.parse(readFileSync(join(repo, 'evals', fixture, workspace, 'package.json'), 'utf8')).name,
      ]);
    await expect(orchestrator.assertRegistryOnly(lockfile(lock.packages), ws)).resolves.toBeUndefined();
  });

  it('accepts scoped packages and the aliases fixtures resolve to, at any version', async () => {
    const sandbox = lockfile({
      'node_modules/@vitest/utils': {
        version: '2.1.9',
        resolved: `${REGISTRY}@vitest/utils/-/utils-2.1.9.tgz`,
      },
      'node_modules/ui5': {
        name: '@sanity/ui',
        version: '5.0.0-alpha.17',
        resolved: `${REGISTRY}@sanity/ui/-/ui-5.0.0-alpha.17.tgz`,
      },
      'node_modules/x/node_modules/@typescript/old': {
        name: 'typescript',
        version: '6.0.3',
        resolved: `${REGISTRY}typescript/-/typescript-6.0.3.tgz`,
      },
      'node_modules/ui5/node_modules/ui5': reg('ui5'),
      'node_modules/sanity': {
        ...reg('sanity'),
        dependencies: { ui5: 'npm:@sanity/ui@5.0.0-alpha.17' },
      },
      'node_modules/x': {
        ...reg('x'),
        dependencies: { '@typescript/old': 'npm:typescript@^6' },
      },
    });
    await expect(orchestrator.assertRegistryOnly(sandbox, [])).resolves.toBeUndefined();
  });

  // Probe's round 3, case 2b: vitest kept, @vitest/utils aliased to another registry package. npm installed it and
  // only the grader's import crashed; a re-exporting alias would run code the agent chose inside the grader.
  it.each([
    [
      'an npm: alias of a package vitest loads',
      {
        'node_modules/@vitest/utils': {
          name: 'left-pad',
          version: '1.3.0',
          resolved: `${REGISTRY}left-pad/-/left-pad-1.3.0.tgz`,
        },
      },
    ],
    // Probe's round 4, case R4-H-bundle: the agent's package.json bundles vitest from a local tarball, and npm marks it
    // inBundle. A bundled entry passes only inside a package that came from the registry.
    [
      'the project bundling a local vitest',
      { 'node_modules/vitest': { resolved: 'file:fakevitest.tgz', inBundle: true } },
    ],
    ['a bundled entry with no parent entry', { 'node_modules/x/node_modules/vitest': { inBundle: true } }],
    [
      'a bundled entry under a bundled root entry',
      { 'node_modules/x': { inBundle: true }, 'node_modules/x/node_modules/vitest': { inBundle: true } },
    ],
    [
      'an alias no registry package declares',
      {
        'node_modules/ui5': {
          name: '@sanity/ui',
          version: '5.0.0-alpha.19',
          resolved: `${REGISTRY}@sanity/ui/-/ui-5.0.0-alpha.19.tgz`,
        },
      },
    ],
    [
      'a known alias name pointing at another package',
      {
        'node_modules/ui5': {
          name: 'left-pad',
          version: '1.3.0',
          resolved: `${REGISTRY}left-pad/-/left-pad-1.3.0.tgz`,
        },
      },
    ],
    [
      'a tarball whose version is not the installed version',
      {
        'node_modules/vitest': {
          version: '2.1.9',
          resolved: `${REGISTRY}vitest/-/vitest-0.0.1.tgz`,
        },
      },
    ],
    [
      'a lock entry naming another package for the same tarball',
      {
        'node_modules/vitest': {
          name: 'left-pad',
          version: '1.0.0',
          resolved: `${REGISTRY}vitest/-/vitest-1.0.0.tgz`,
        },
      },
    ],
  ])('refuses %s', async (_, packages) => {
    await expect(orchestrator.assertRegistryOnly(lockfile(packages), [])).rejects.toThrow(/Grader refused/);
  });

  // Probe's round 3, case 3a: npm records registry.npmjs.org as the source even when an .npmrc registry (or a scoped
  // @x:registry) sent the downloads elsewhere, so the registry check cannot see it. The verifier keeps the fixture's .npmrc.
  it('never replays an .npmrc the agent wrote or changed', () => {
    const isProtected = orchestratorVerifier.createProtectedPathMatcher(orchestratorVerifier.VERIFIER_PROTECTED_PATHS);
    for (const npmrcPath of ['.npmrc', 'studio/.npmrc', 'a/b/.npmrc']) expect(isProtected(npmrcPath)).toBe(true);
    expect(isProtected('src/npmrc.ts')).toBe(false);
  });

  it.each([
    [
      'a file: dependency',
      {
        'node_modules/vitest': { resolved: 'fake', link: true },
        fake: { name: 'vitest' },
      },
      [],
    ],
    [
      'a git dependency',
      {
        'node_modules/vitest': {
          resolved: 'git+ssh://git@github.com/x/vitest.git#abc',
        },
      },
      [],
    ],
    [
      'a non-npm registry',
      {
        'node_modules/vitest': {
          resolved: 'https://evil.example/vitest-1.0.0.tgz',
        },
      },
      [],
    ],
    [
      'a workspace renamed to vitest',
      {
        studio: { name: 'vitest' },
        'node_modules/vitest': { resolved: 'studio', link: true },
      },
      [['studio', 'studio']],
    ],
    ['a workspace the fixture did not ship', studioLinks, []],
    [
      'a bundled entry inside a shipped workspace',
      { ...studioLinks, 'studio/node_modules/vitest': { inBundle: true } },
      [['studio', 'studio']],
    ],
    [
      'a bundled entry under a non-registry parent',
      {
        'node_modules/x': { resolved: 'file:x.tgz', link: false },
        'node_modules/x/node_modules/vitest': { inBundle: true },
      },
      [],
    ],
    [
      'a nameless folder entry whose folder is not the shipped package name',
      {
        apps: { version: '1.0.0' },
        'node_modules/vitest': { resolved: 'apps', link: true },
      },
      [['apps', 'studio']],
    ],
  ])('refuses %s', async (_, packages, workspaces) => {
    await expect(orchestrator.assertRegistryOnly(lockfile(packages), workspaces)).rejects.toThrow(/Grader refused/);
  });
});
