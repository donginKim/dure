import { openDatabase } from '@core/db';
import { ScheduleService, nextRun } from '@core/schedule';

const at = (h: number, m = 0, day = 16): number => new Date(2026, 10, day, h, m).getTime();
function make(nowRef: { t: number }, blocked: () => string | null = () => null) {
  const sent: { ws: string; body: string }[] = [];
  const s = new ScheduleService({
    db: openDatabase(':memory:'), now: () => nowRef.t,
    workspace: (id) => (id === 'w1' ? { id, projectId: 'p1', name: 'API' } : undefined),
    isProjectClosed: () => false, blocked, send: (_p, ws, body) => { sent.push({ ws, body }); },
  });
  return { s, sent };
}

test('nextRun: 매일·매주·한 번의 다음 때', () => {
  const base = { enabled: true, weekday: null, runAt: null };
  // 2026-11-16 은 월요일
  expect(nextRun({ ...base, kind: 'daily', time: '09:00', lastRunAt: at(8) }, at(8, 30))).toBe(at(9));
  expect(nextRun({ ...base, kind: 'daily', time: '09:00', lastRunAt: at(9, 0) }, at(10))).toBe(at(9, 0, 17));
  expect(nextRun({ ...base, kind: 'weekly', time: '17:00', weekday: 5, lastRunAt: at(8) }, at(10))).toBe(at(17, 0, 20));
  expect(nextRun({ ...base, kind: 'once', time: '', runAt: at(12), lastRunAt: null }, at(10))).toBe(at(12));
  expect(nextRun({ ...base, kind: 'once', time: '', runAt: at(12), lastRunAt: at(12) }, at(13))).toBeNull();
  expect(nextRun({ ...base, enabled: false, kind: 'daily', time: '09:00', lastRunAt: null }, at(10))).toBeNull();
});

test('예약 실행: 때가 되면 한 번 보내고, 만들자마자 돌지 않고, 꺼 두었다 켜도 밀린 것을 몰아서 돌지 않는다', () => {
  const now = { t: at(10) };
  const { s, sent } = make(now);
  // 오늘 9시는 이미 지났다: 만들자마자 돌지 않고 내일 9시에 돈다
  const daily = s.save({ workspaceId: 'w1', title: '의존성 점검', prompt: '오래된 패키지를 찾아라', kind: 'daily', time: '09:00' });
  expect(daily.nextAt).toBe(at(9, 0, 17));
  s.tick();
  expect(sent).toEqual([]);
  now.t = at(9, 1, 17);
  s.tick(); s.tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toContain('오래된 패키지를 찾아라');
  // 한 번짜리: 30분 뒤
  s.save({ workspaceId: 'w1', title: '배포 확인', prompt: '배포 결과를 봐라', kind: 'once', runAt: now.t + 30 * 60_000 });
  now.t += 31 * 60_000;
  s.tick(); s.tick();
  expect(sent).toHaveLength(2);
  // 사흘 꺼 두었다 켜면: 밀린 사흘치가 아니라 오늘 것 한 번만 돈다
  now.t = at(12, 0, 21);
  s.tick(); s.tick();
  expect(sent).toHaveLength(3);
  now.t = at(9, 1, 22);
  s.tick();
  expect(sent).toHaveLength(4);
  // 지금 돌리기, 끄기, 잘못된 입력
  s.runNow(daily.id);
  expect(sent).toHaveLength(5);
  s.setEnabled(daily.id, false);
  expect(s.list('p1').find((x) => x.id === daily.id)!.nextAt).toBeNull();
  expect(() => s.save({ workspaceId: 'nope', title: 'x', prompt: 'y', kind: 'daily' })).toThrow('워크스페이스가 없습니다');
  expect(() => s.save({ workspaceId: 'w1', title: '', prompt: 'y', kind: 'daily' })).toThrow('제목');
});

test('예산을 넘은 프로젝트면 보내지 않고 까닭을 알린다', () => {
  const now = { t: at(10) };
  const { s, sent } = make(now, () => '오늘의 상한을 넘었습니다');
  const x = s.save({ workspaceId: 'w1', title: 't', prompt: 'p', kind: 'daily', time: '09:00' });
  expect(() => s.runNow(x.id)).toThrow('상한');
  expect(sent).toEqual([]);
});
