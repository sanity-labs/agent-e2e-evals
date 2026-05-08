import { readFileSync, existsSync } from 'fs';
import { test, expect } from 'vitest';

test('projects.txt exists', () => {
  expect(existsSync('projects.txt')).toBe(true);
});

test('projects.txt contains project entries', () => {
  const content = readFileSync('projects.txt', 'utf-8').trim();
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
});

test('entries follow the expected format', () => {
  const content = readFileSync('projects.txt', 'utf-8').trim();
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    expect(line).toMatch(/^[a-z0-9]+ - .+/);
  }
});
