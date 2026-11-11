import { groupTodos, progress, TODO_STATUS_LABEL } from '../../src/renderer/todoView';
import type { Todo, Workspace } from '@shared/types';

const ws = (id: string, createdAt: number): Workspace => ({
  id, projectId: 'p', repoId: 'r', name: `ws-${id}`, nameLocked: false, summary: '', branch: 'b', baseBranch: 'main',
  worktreePath: '/w', agentKind: 'claude', permissionMode: 'ask', status: 'stopped', createdAt,
});
const todo = (id: string, workspaceId: string | null, position: number, status: Todo['status'] = 'todo'): Todo => ({
  id, projectId: 'p', workspaceId, title: id, detail: '', status, assignee: 'agent', position, rev: 1, updatedBy: 'agent', createdAt: 0, updatedAt: 0,
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
