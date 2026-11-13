import { childrenOf, groupTodos, progress, TODO_STATUS_LABEL } from '../../src/renderer/todoView';
import type { Todo, Workspace } from '@shared/types';

const ws = (id: string, createdAt: number): Workspace => ({
  id, projectId: 'p', role: 'worker', repoId: 'r', name: `ws-${id}`, nameLocked: false, summary: '', branch: 'b', baseBranch: 'main',
  worktreePath: '/w', agentKind: 'claude', permissionMode: 'ask', engine: 'chat', status: 'stopped', createdAt,
});
const todo = (id: string, workspaceId: string | null, position: number, status: Todo['status'] = 'todo'): Todo => ({
  id, projectId: 'p', workspaceId, parentId: null, after: [], title: id, detail: '', status, assignee: 'agent', position, rev: 1, updatedBy: 'agent', createdAt: 0, updatedAt: 0,
});

test('groupTodos: 프로젝트 묶음이 먼저, 이어서 워크스페이스 생성 순, 항목 없는 워크스페이스도 묶음으로 나온다', () => {
  const groups = groupTodos([todo('b1', 'B', 1), todo('p1', null, 1)], [ws('B', 20), ws('A', 10)]);
  expect(groups.map((g) => [g.key, g.title, g.workspaceId, g.items.map((t) => t.id)])).toEqual([
    ['project', '프로젝트', null, ['p1']],
    ['A', 'ws-A', 'A', []],
    ['B', 'ws-B', 'B', ['b1']],
  ]);
});

test('groupTodos: 묶음 안은 position 순', () => {
  const groups = groupTodos([todo('x', 'A', 3), todo('y', 'A', 1), todo('z', 'A', 2)], [ws('A', 1)]);
  expect(groups[1].items.map((t) => t.id)).toEqual(['y', 'z', 'x']);
});

test('progress: done 과 total, cancelled 는 total 에서 뺀다', () => {
  expect(progress([todo('a', 'A', 1, 'done'), todo('b', 'A', 2, 'todo'), todo('c', 'A', 3, 'cancelled'), todo('d', 'A', 4, 'doing')]))
    .toEqual({ done: 1, total: 3 });
  expect(progress([])).toEqual({ done: 0, total: 0 });
});

test('TODO_STATUS_LABEL', () => {
  expect(TODO_STATUS_LABEL).toEqual({ todo: '할 일', doing: '진행 중', done: '완료', cancelled: '취소' });
});

test('childrenOf: 프로젝트 항목에 딸린 워크스페이스 항목을 워크스페이스를 만든 순서로 낸다', () => {
  const under = (t: Todo, parentId: string): Todo => ({ ...t, parentId });
  const all = [todo('큰일', null, 1), under(todo('b1', 'b', 1), '큰일'), under(todo('a2', 'a', 2, 'done'), '큰일'), under(todo('a1', 'a', 1), '큰일'), todo('딴일', 'a', 3), under(todo('남의것', 'a', 4), '다른큰일')];
  expect(childrenOf('큰일', all, [ws('b', 2), ws('a', 1)]).map((k) => [k.workspace, k.todo.id])).toEqual([['ws-a', 'a1'], ['ws-a', 'a2'], ['ws-b', 'b1']]);
  expect(childrenOf('없음', all, [])).toEqual([]);
});
