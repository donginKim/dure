import { fuzzy } from '../../src/renderer/components/CommandPalette';

test('fuzzy: 이어진 글자가 먼저, 띄엄띄엄 맞아도 찾고, 없으면 -1', () => {
  expect(fuzzy('결제 API', '결제')).toBe(0);
  expect(fuzzy('결제 API 쇼핑몰', 'api')).toBe(2);
  expect(fuzzy('결제 API', '결api')).toBeGreaterThanOrEqual(100);
  expect(fuzzy('결제 API', '주문')).toBe(-1);
  expect(fuzzy('아무거나', '')).toBe(0);
  expect(fuzzy('주문 화면', '주화')).toBeLessThan(fuzzy('주문 목록 화면', '주화'));
});
