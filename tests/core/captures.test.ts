import { openDatabase } from '@core/db';
import { CaptureStore } from '@core/captures';

test('빠른 메모: 적고, 새것부터 보이고, TODO 로 보내면 첫 줄이 제목이 되고 메모는 지워진다', () => {
  const todos: unknown[] = [];
  const c = new CaptureStore({ db: openDatabase(':memory:'), addTodo: (projectId, workspaceId, title, detail) => { todos.push({ projectId, workspaceId, title, detail }); } });
  expect(() => c.add('   ')).toThrow('적을 글');
  const a = c.add('결제 오류 로그 확인\n어제 배포 뒤 500 이 늘었다');
  c.add('회의록 정리');
  expect(c.list().map((x) => x.text)).toContain('회의록 정리');
  c.toTodo(a.id, 'p1', null);
  expect(todos).toEqual([{ projectId: 'p1', workspaceId: null, title: '결제 오류 로그 확인', detail: '어제 배포 뒤 500 이 늘었다' }]);
  expect(c.list()).toHaveLength(1);
  expect(() => c.toTodo(a.id, 'p1', null)).toThrow('메모가 없습니다');
  c.remove(c.list()[0]!.id);
  expect(c.list()).toEqual([]);
});
