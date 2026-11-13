import type { AssignmentOut } from '@shared/types';
import { boardAge, boardTotals, remoteGroups, workStateLabel } from '../../src/renderer/boardView';
import { childrenOf } from '../../src/renderer/todoView';

const out = (o: Partial<AssignmentOut>): AssignmentOut => ({ id: 'a1', projectId: 'p', peerId: 'x', peerName: '개발', state: 'sent', items: [], progress: [], note: '', createdAt: 0, updatedAt: 0, ...o });
const t = (title: string, goal?: string) => ({ title, detail: '', assignee: 'agent' as const, ...(goal ? { goal } : {}) });

test('boardAge, boardTotals, workStateLabel', () => {
  expect(boardAge(1000, 1000 + 20_000)).toBe('방금 받음');
  expect(boardAge(0, 5 * 60_000)).toBe('5분 전 기준');
  expect(boardAge(0, 3 * 3_600_000)).toBe('3시간 전 기준');
  expect(boardAge(0, 50 * 3_600_000)).toBe('2일 전 기준');
  expect(boardTotals({ goals: [{ title: 'a', status: 'done', assignee: 'agent', done: 1, total: 1 }, { title: 'b', status: 'doing', assignee: 'agent', done: 0, total: 2 }] })).toEqual({ goals: 2, goalsDone: 1 });
  expect([workStateLabel({ state: 'active' }), workStateLabel({ state: 'waiting' }), workStateLabel({ state: 'unknown' })]).toEqual(['', '수락을 기다리는 중', '진행을 받지 못함']);
});

test('remoteGroups: 나눠 준 일이 "워크스페이스@사람" 묶음으로 나오고, 프로젝트 항목에 딸린다', () => {
  const items = [{ name: '로그인 API', role: '인증', todos: [t('POST /login', 'G1'), t('문서')] }];
  // 수락 전: 보낸 그대로, 모두 할 일
  const waiting = remoteGroups('p', [out({ items })]);
  expect(waiting.workspaces.map((w) => w.name)).toEqual(['로그인 API@개발']);
  expect(waiting.notes[waiting.workspaces[0]!.id]).toBe('수락을 기다리는 중');
  expect(waiting.todos.map((x) => [x.title, x.status, x.parentId])).toEqual([['POST /login', 'todo', 'G1'], ['문서', 'todo', null]]);
  // 거절한 것은 나오지 않는다
  expect(remoteGroups('p', [out({ items, state: 'declined' })]).workspaces).toEqual([]);
  // 진행을 받은 것: 그 사람의 워크스페이스와 상태. 제목으로 딸린 곳을 찾는다
  const active = remoteGroups('p', [out({ items, state: 'accepted', progress: [{ workspaceId: 'w9', name: 'API', status: 'working', summary: '', todos: [{ title: 'POST /login', status: 'done', assignee: 'agent' }, { title: '새로 더한 일', status: 'doing', assignee: 'agent' }] }] })]);
  expect(active.workspaces.map((w) => w.name)).toEqual(['API@개발']);
  expect(active.notes).toEqual({});
  expect(active.todos.map((x) => [x.title, x.status, x.parentId])).toEqual([['POST /login', 'done', 'G1'], ['새로 더한 일', 'doing', null]]);
  expect(childrenOf('G1', active.todos, active.workspaces).map((k) => [k.workspace, k.todo.title])).toEqual([['API@개발', 'POST /login']]);
});
