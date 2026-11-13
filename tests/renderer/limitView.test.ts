import { limitText } from '../../src/renderer/limitView';

test('한도 띠의 글', () => {
  const at = new Date(); at.setHours(15, 30, 0, 0);
  const base = { kind: 'seven_day_opus', resetsAt: Math.floor(at.getTime() / 1000), utilization: null, model: '', at: 0 };
  expect(limitText({ ...base, status: 'rejected' }, 0)).toBe('Opus 주간 한도에 걸려 멈췄습니다 (15:30 에 풀립니다). 다른 모델로 바꾸면 대화를 끊지 않고 이어 갈 수 있습니다.');
  expect(limitText({ ...base, status: 'warning', kind: 'five_hour', utilization: 0.9 }, 0)).toBe('5시간 한도에 가까워졌습니다 90% (15:30 에 풀립니다).');
  expect(limitText({ ...base, status: 'rejected', kind: '', resetsAt: null }, 0)).toBe('사용 한도에 걸려 멈췄습니다. 다른 모델로 바꾸면 대화를 끊지 않고 이어 갈 수 있습니다.');
});
