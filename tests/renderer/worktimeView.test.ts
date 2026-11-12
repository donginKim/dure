import { atTime, breakLabel, canLeave, duration, hhmm, monthGrid, monthTotal, leftToLeave, parseBreak, workBadge } from '../../src/renderer/worktimeView';

test('걸린 시간과 시각을 읽기 쉽게 적는다', () => {
  expect(duration(20_000)).toBe('1분 미만');
  expect(duration(45 * 60_000)).toBe('45분');
  expect(duration(8 * 3_600_000)).toBe('8시간');
  expect(duration(8 * 3_600_000 + 12 * 60_000)).toBe('8시간 12분');
  expect(hhmm(new Date(2026, 10, 13, 9, 2).getTime())).toBe('09:02');
});

test('달력의 칸: 일요일부터, 주 단위로 채운다', () => {
  // 2026년 11월 1일은 일요일, 30일까지
  const day = { day: '2026-11-13', totalMs: 3_600_000, grossMs: 3_600_000, breakMin: 0, firstAt: 1, lastAt: 2, sessions: [] };
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

test('휴게 시간을 여러 꼴로 적을 수 있다', () => {
  expect(parseBreak('90')).toBe(90);
  expect(parseBreak('60분')).toBe(60);
  expect(parseBreak('1:30')).toBe(90);
  expect(parseBreak('1시간')).toBe(60);
  expect(parseBreak('1시간 30분')).toBe(90);
  expect(parseBreak('1.5시간')).toBe(90);
  expect(parseBreak('')).toBe(0);
  expect(parseBreak('점심')).toBeNull();
  expect(breakLabel(90)).toBe('1시간 30분');
});

test('창 구석의 근무 표시: 근무 중일 때만, 오늘 몇 시간째인지', () => {
  const open = { id: 's', day: 'd', startAt: 0, endAt: 0, open: true, auto: false };
  const base = { enabled: true, unit: 'half' as const, openSession: open, atWork: true, todayMs: 5.5 * 3_600_000 };
  expect(workBadge(base)).toBe('근무 중 · 5시간 30분');
  // 올려 적은 출근 시각이 아직 오지 않았다
  expect(workBadge({ ...base, todayMs: 0 })).toBe('근무 중 · 0분');
  // 퇴근했거나, 재지 않으면 보이지 않는다
  expect(workBadge({ ...base, openSession: null })).toBeNull();
  expect(workBadge({ ...base, enabled: false })).toBeNull();
  // 붙어 있던 시간 그대로 세는 방식에서는 근무지에 붙어 있을 때
  expect(workBadge({ ...base, unit: 'minute', openSession: null, atWork: true, todayMs: 45 * 60_000 })).toBe('근무 중 · 45분');
  expect(workBadge({ ...base, unit: 'minute', openSession: null, atWork: false })).toBeNull();
});

test('날짜와 시각을 그날 그 시각으로 바꾼다', () => {
  expect(atTime('2026-11-13', '08:00')).toBe(new Date(2026, 10, 13, 8, 0).getTime());
  expect(atTime('2026-11-13', '8:30')).toBe(new Date(2026, 10, 13, 8, 30).getTime());
  expect(atTime('2026-11-13', '25:00')).toBeNull();
  expect(atTime('2026-11-13', '')).toBeNull();
  expect(atTime('어제', '08:00')).toBeNull();
});

test('휴게 시간을 뺀 근무시간을 채우면 퇴근할 수 있다고 알린다', () => {
  const open = { id: 's', day: 'd', startAt: 0, endAt: 0, open: true, auto: false };
  const base = { enabled: true, unit: 'half' as const, openSession: open, atWork: true, todayMs: 7.5 * 3_600_000, targetMs: 8 * 3_600_000 };
  expect(canLeave(base)).toBe(false);
  expect(leftToLeave(base)).toBe(30 * 60_000);
  expect(canLeave({ ...base, todayMs: 8 * 3_600_000 })).toBe(true);
  expect(leftToLeave({ ...base, todayMs: 9 * 3_600_000 })).toBe(0);
  // 퇴근했거나, 근무시간을 정해 두지 않았으면 알리지 않는다
  expect(canLeave({ ...base, todayMs: 9 * 3_600_000, openSession: null })).toBe(false);
  expect(canLeave({ ...base, todayMs: 9 * 3_600_000, targetMs: 0 })).toBe(false);
  expect(leftToLeave({ todayMs: 0, targetMs: 0 })).toBe(0);
});
