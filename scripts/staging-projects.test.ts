import { expect, test } from 'vitest';
import { newlyObserved } from './staging-projects.ts';

test('names projects first seen during the batch, never the protected canary', () => {
  const before = [{ id: 'old1' }, { id: 'old2' }];
  const after = [{ id: 'old1' }, { id: 'new1' }, { id: 'bos8r3z6' }];
  expect(newlyObserved(before, after)).toEqual([{ id: 'new1' }]);
});

test('a project gone after the batch is not a candidate', () => {
  expect(newlyObserved([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }])).toEqual([]);
});
