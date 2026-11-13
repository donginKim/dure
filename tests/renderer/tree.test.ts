import { buildTree, reconcileSelection, STATUS_LABEL } from '../../src/renderer/tree';
import type { Project, Workspace } from '@shared/types';

const project = (id: string, createdAt: number): Project => ({ id, name: id, createdAt, status: 'active', completedAt: null, autoShip: 'off', budgetDaily: 0, budgetTotal: 0 });
const ws = (id: string, projectId: string, createdAt: number): Workspace => ({
  id, projectId, role: 'worker', repoId: 'r', name: id, nameLocked: false, summary: '', branch: 'b', baseBranch: 'main',
  worktreePath: '/w', agentKind: 'claude', permissionMode: 'ask', engine: 'chat', model: '', status: 'stopped', createdAt,
});

test('buildTree 는 워크스페이스를 프로젝트 아래에 createdAt 순으로 묶는다', () => {
  const tree = buildTree([project('p2', 20), project('p1', 10)], [ws('b', 'p1', 2), ws('a', 'p1', 1), ws('c', 'p2', 3)]);
  expect(tree.map((n) => n.project.id)).toEqual(['p1', 'p2']);
  expect(tree[0].workspaces.map((w) => w.id)).toEqual(['a', 'b']);
  expect(tree[1].workspaces.map((w) => w.id)).toEqual(['c']);
});

test('워크스페이스가 없는 프로젝트도 노드로 나온다', () => {
  expect(buildTree([project('p1', 1)], [])).toEqual([{ project: project('p1', 1), workspaces: [] }]);
});

test('reconcileSelection: 대상이 있으면 그대로 둔다', () => {
  const tree = buildTree([project('p1', 1)], [ws('a', 'p1', 1)]);
  expect(reconcileSelection({ type: 'workspace', id: 'a' }, tree)).toEqual({ type: 'workspace', id: 'a' });
  expect(reconcileSelection({ type: 'project', id: 'p1' }, tree)).toEqual({ type: 'project', id: 'p1' });
  expect(reconcileSelection(null, tree)).toBeNull();
});

test('reconcileSelection: 선택한 워크스페이스가 사라지면 그 프로젝트를 선택한다', () => {
  const tree = buildTree([project('p1', 1)], []);
  expect(reconcileSelection({ type: 'workspace', id: 'a', projectId: 'p1' }, tree)).toEqual({ type: 'project', id: 'p1' });
});

test('reconcileSelection: 프로젝트도 사라지면 null', () => {
  expect(reconcileSelection({ type: 'workspace', id: 'a', projectId: 'p1' }, [])).toBeNull();
  expect(reconcileSelection({ type: 'project', id: 'p1' }, [])).toBeNull();
});

test('상태 글자', () => {
  expect(STATUS_LABEL).toEqual({ stopped: '꺼짐', starting: '시작 중', idle: '쉬는 중', working: '작업 중', waiting_user: '사용자 기다림' });
});

test('countByRepo 는 저장소별 워크스페이스 수를 센다', async () => {
  const { countByRepo } = await import('../../src/renderer/tree');
  const a = { ...ws('a', 'p1', 1), repoId: 'r1' };
  const b = { ...ws('b', 'p1', 2), repoId: 'r1' };
  const c = { ...ws('c', 'p1', 3), repoId: 'r2' };
  expect(countByRepo([a, b, c])).toEqual({ r1: 2, r2: 1 });
  expect(countByRepo([])).toEqual({});
});

test('설정 화면을 고른 것은 목록이 바뀌어도 그대로다', () => {
  expect(reconcileSelection({ type: 'settings' }, [])).toEqual({ type: 'settings' });
});
