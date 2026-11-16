import { openDatabase } from '@core/db';
import { PaddyService, dayOf, paddyScore } from '@core/paddy';
import { paddyStage, streakOf } from '../../src/renderer/components/Paddy';

test('두레 논: 날마다 끝낸 TODO, 커밋, main 반영을 세고 점수로 단계를 정한다. 프로젝트를 고를 수 있다', () => {
  const db = openDatabase(':memory:');
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  const p = new PaddyService(db, () => now);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'a', 0), ('p2', 'b', 0)").run();
  const todo = (id: string, project: string, status: string, at: number): void => {
    db.prepare("INSERT INTO todos (id, project_id, title, status, position, updated_by, created_at, updated_at) VALUES (?, ?, 't', ?, 0, 'agent', 0, ?)").run(id, project, status, at);
  };
  todo('a', 'p1', 'done', now - 3_600_000);
  todo('b', 'p1', 'done', now - 86_400_000);
  todo('c', 'p2', 'done', now - 3_600_000);
  todo('d', 'p1', 'todo', now);
  p.note('commit', 'p1', 'w'); p.note('main', 'p1', null);
  const all = p.days(null, 30);
  expect(all).toHaveLength(30);
  expect(all.at(-1)).toMatchObject({ date: dayOf(now), todos: 2, commits: 1, mains: 1, score: 6 });
  expect(all.at(-2)).toMatchObject({ todos: 1, score: 1 });
  expect(p.days('p2', 30).at(-1)).toMatchObject({ todos: 1, commits: 0, score: 1 });
  expect(paddyScore({ todos: 1, commits: 2, mains: 1 })).toBe(6);
  expect([0, 1, 3, 6, 12].map(paddyStage)).toEqual([0, 1, 2, 3, 4]);
  // 연속: 오늘이 비었으면 어제부터 센다
  expect(streakOf(all)).toBe(2);
  expect(streakOf([...all.slice(0, -1), { ...all.at(-1)!, score: 0 }])).toBe(1);
});
