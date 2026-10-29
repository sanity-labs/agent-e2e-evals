import { expect, test } from 'vitest';
import { baseSetup } from './base-setup.ts';

test('baseSetup never writes the host SANITY_AUTH_TOKEN into the sandbox .env', async () => {
  const sentinel = 'skSENTINEL0000000000000000000000000000000000000000000000000000000000';
  const prior = process.env.SANITY_AUTH_TOKEN;
  process.env.SANITY_AUTH_TOKEN = sentinel;
  const written: Record<string, string> = {};
  try {
    await baseSetup({ writeFiles: async (files: Record<string, string>) => Object.assign(written, files) } as never);
  } finally {
    if (prior === undefined) delete process.env.SANITY_AUTH_TOKEN;
    else process.env.SANITY_AUTH_TOKEN = prior;
  }
  expect(written['.env']).not.toContain(sentinel);
  expect(written['.env']).toContain('SANITY_AUTH_TOKEN=placeholder');
});
