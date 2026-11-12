import { duration, hhmm, monthGrid, monthTotal } from '../../src/renderer/worktimeView';

test('걸린 시간과 시각을 읽기 쉽게 적는다', () => {
  expect(duration(20_000)).toBe('1분 미만');
  expect(duration(45 * 60_000)).toBe('45분');
  expect(duration(8 * 3_600_000)).toBe('8시간');
  expect(duration(8 * 3_600_000 + 12 * 60_000)).toBe('8시간 12분');
  expect(hhmm(new Date(2026, 10, 13, 9, 2).getTime())).toBe('09:02');
});

test('달력의 칸: 일요일부터, 주 단위로 채운다', () => {
  // 2026년 11월 1일은 일요일, 30일까지
  const day = { day: '2026-11-13', totalMs: 3_600_000, firstAt: 1, lastAt: 2, sessions: [] };
  const cells = monthGrid(2026, 11, [day]);
  expect(cells.length).toBe(35);
  expect(cells[0]).toMatchObject({ day: 1, weekend: true });
  expect(cells[12]).toMatchObject({ day: 13, key: '2026-11-13', data: day, weekend: false });
  expect(cells[29]!.day).toBe(30);
  expect(cells.slice(30).every((c) => c.day === null)).toBe(true);
  // 2026년 8월 1일은 토요일: 앞에 빈칸 6개, 6주
  const aug = monthGrid(2026, 8, []);
  expect(aug.slice(0, 6).every((c) => c.day === null)).toBe(true);
  expect(aug[6]).toMatchObject({ day: 1, weekend: true });
  expect(aug.length).toBe(42);
  expect(monthTotal([day, { ...day, day: 'x', totalMs: 0 }])).toEqual({ days: 1, ms: 3_600_000 });
});
