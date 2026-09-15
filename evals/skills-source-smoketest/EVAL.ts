import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

test(`agent read the selected skills source (${process.env.EXPECTED_SKILL_SHA})`, () => {
  expect(process.env.EXPECTED_SKILL_SHA).toMatch(/^[a-f0-9]{64}$/);
  const actual = createHash('sha256').update(readFileSync('observed-skill.md')).digest('hex');
  expect(actual).toBe(process.env.EXPECTED_SKILL_SHA);
});
