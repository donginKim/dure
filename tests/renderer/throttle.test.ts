import { throttled } from '../../src/renderer/throttle';

test('throttled: 처음은 바로, 그 뒤 몰려온 것은 한 번으로 모은다', async () => {
  let n = 0;
  const f = throttled(() => { n++; }, 80);
  f(); f(); f();
  expect(n).toBe(1);
  await new Promise((r) => setTimeout(r, 130));
  expect(n).toBe(2);
  f.cancel();
});
