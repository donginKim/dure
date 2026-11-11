import type { CleanupItem, CompletionPlan } from '@shared/types';
import { choiceSummary, defaultChoice, formatBytes, worktreeRisk } from '../../src/renderer/cleanupView';

const ws = (id: string, o: Partial<CompletionPlan['workspaces'][number]> = {}): CompletionPlan['workspaces'][number] =>
  ({ id, name: id, branch: `dure/${id}`, worktreePath: `/w/${id}`, exists: true, uncommitted: 0, unpushed: 0, agentRunning: false, ...o });
const item = (id: string, size: number): CleanupItem =>
  ({ id, projectId: 'p', workspaceId: 'a', workspaceName: 'a', path: `${id}.log`, reason: '', size, isDir: false, createdAt: 0 });

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0B');
  expect(formatBytes(900)).toBe('900B');
  expect(formatBytes(1536)).toBe('1.5KB');
  expect(formatBytes(200 * 1024)).toBe('200KB');
  expect(formatBytes(5 * 1024 * 1024)).toBe('5.0MB');
  expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0GB');
});

test('worktreeRisk: 커밋하지 않은 변경이 가장 먼저, 다음이 원격에 없는 브랜치와 push 하지 않은 커밋', () => {
  expect(worktreeRisk(ws('a'))).toBeNull();
  expect(worktreeRisk(ws('a', { uncommitted: 3, unpushed: 2 }))).toContain('커밋하지 않은 변경 3건');
  expect(worktreeRisk(ws('a', { unpushed: null }))).toContain('원격에 없습니다');
  expect(worktreeRisk(ws('a', { unpushed: 2 }))).toContain('push 하지 않은 커밋 2건');
  expect(worktreeRisk(ws('a', { exists: false, uncommitted: 9 }))).toBeNull();
});

test('defaultChoice: 정리 대기는 전부, 작업 폴더는 커밋하지 않은 변경이 없고 아직 있는 것만', () => {
  const plan: CompletionPlan = { workspaces: [ws('clean'), ws('dirty', { uncommitted: 1 }), ws('gone', { exists: false }), ws('unpushed', { unpushed: 4 })], items: [item('x', 10), item('y', 20)] };
  expect(defaultChoice(plan)).toEqual({ removeWorktrees: ['clean', 'unpushed'], removeItems: ['x', 'y'] });
});

test('choiceSummary', () => {
  const plan: CompletionPlan = { workspaces: [ws('a'), ws('b')], items: [item('x', 1024), item('y', 1024)] };
  expect(choiceSummary(plan, { removeWorktrees: ['a'], removeItems: ['x', 'y'] })).toBe('작업 폴더 1개, 정리 대기 2건 (2.0KB)을(를) 지웁니다');
  expect(choiceSummary(plan, { removeWorktrees: [], removeItems: [] })).toBe('아무것도 지우지 않습니다');
  // 목록에 없는 id 는 세지 않는다
  expect(choiceSummary(plan, { removeWorktrees: ['zzz'], removeItems: ['x'] })).toBe('정리 대기 1건 (1.0KB)을(를) 지웁니다');
});
