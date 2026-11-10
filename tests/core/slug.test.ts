import { slugify, uniqueSlug } from '@core/slug';

test.each([
  ['로그인 기능', '로그인-기능'],
  ['  a   b ', 'a-b'],
  ['feat/x:y', 'featxy'],
  ['..hidden..', 'hidden'],
  ['???', 'ws'],
  ['a..b', 'a.b'],
  ['-lead', 'lead'],
  ['', 'ws'],
])('slugify(%j) = %j', (input, expected) => {
  expect(slugify(input)).toBe(expected);
});

test('uniqueSlug 는 겹치면 -2, -3 을 붙인다', () => {
  const taken = new Set(['a', 'a-2']);
  expect(uniqueSlug('a', (c) => taken.has(c))).toBe('a-3');
  expect(uniqueSlug('b', (c) => taken.has(c))).toBe('b');
});
