import { openDatabase } from '@core/db';
import { DigestService } from '@core/digest';
import { reportText } from '../../src/renderer/digestView';

test('하루 결산: 그날 끝낸 TODO·커밋·main 반영·토큰을 프로젝트별로 모으고, 보고서 글로 만든다', () => {
  const db = openDatabase(':memory:');
  const now = new Date(2026, 10, 16, 18, 0).getTime();
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', '쇼핑몰', 0), ('p2', '끝난 것', 0)").run();
  const todo = (id: string, p: string, title: string, status: string, at: number): void => {
    db.prepare("INSERT INTO todos (id, project_id, title, status, position, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'agent', 0, ?)").run(id, p, title, status, at);
  };
  todo('a', 'p1', '결제 API', 'done', now - 3_600_000);
  todo('b', 'p1', '어제 한 것', 'done', now - 86_400_000);
  todo('c', 'p1', '주문 화면', 'doing', now);
  todo('d', 'p1', '나중', 'todo', now);
  todo('e', 'p2', '닫힌 프로젝트의 일', 'doing', now);
  db.prepare("INSERT INTO work_events (kind, project_id, workspace_id, at) VALUES ('commit', 'p1', null, ?), ('main', 'p1', null, ?)").run(now - 1000, now - 500);
  const d = new DigestService({
    db, now: () => now, projects: () => [{ id: 'p1', name: '쇼핑몰', status: 'active' }, { id: 'p2', name: '끝난 것', status: 'done' }],
    workspaceName: () => '', workMs: () => 7.5 * 3_600_000, attention: () => [{ title: '답을 기다립니다', projectName: '쇼핑몰' }],
  });
  const today = d.daily(0);
  expect(today.totals).toMatchObject({ done: 1, commits: 1, mains: 1, workMs: 27_000_000 });
  expect(today.projects[0]).toMatchObject({ name: '쇼핑몰', done: [{ title: '결제 API' }] });
  // 완료된 프로젝트의 일은 이어 갈 일에 넣지 않는다
  expect(today.doing).toEqual([{ title: '주문 화면', project: '쇼핑몰' }]);
  expect(today.todo).toBe(1);
  expect(today.attention).toHaveLength(1);
  const y = d.daily(1);
  expect(y.projects[0]!.done.map((t) => t.title)).toEqual(['어제 한 것']);
  expect(y.attention).toEqual([]);
  const text = reportText(today);
  expect(text).toContain('## 11월 16일 한 일');
  expect(text).toContain('TODO 1개 완료 · 커밋 1 · main 반영 1 · 근무 7시간 30분');
  expect(text).toContain('- 결제 API');
  expect(text).toContain('### 이어서 할 일');
});
