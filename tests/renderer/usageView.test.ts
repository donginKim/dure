import { inputAll, share, tokens } from '../../src/renderer/usageView';

test('토큰 수를 읽기 쉽게 적는다', () => {
  expect(tokens(0)).toBe('0');
  expect(tokens(9_999)).toBe('9,999');
  expect(tokens(12_345)).toBe('12.3천');
  expect(tokens(456_789)).toBe('457천');
  expect(tokens(1_234_567)).toBe('1.23백만');
  expect(tokens(45_600_000)).toBe('45.6백만');
});

test('전체에서 차지하는 몫', () => {
  const c = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheWrite: 0, cacheRead, requests: 1 });
  expect(inputAll(c(10, 0, 90))).toBe(100);
  expect(share(c(10, 40, 0), c(20, 80, 0))).toBe(50);
  expect(share(c(1, 1), c(0, 0))).toBe(0);
});
