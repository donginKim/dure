import type { CleanupItem, CompletionPlan } from '@shared/types';
import { choiceSummary, defaultChoice, formatBytes, ignoredNote, worktreeRisk } from '../../src/renderer/cleanupView';

const ws = (id: string, o: Partial<CompletionPlan['workspaces'][number]> = {}): CompletionPlan['workspaces'][number] =>
  ({ id, name: id, branch: `dure/${id}`, worktreePath: `/w/${id}`, exists: true, uncommitted: 0, ignored: 0, unpushed: 0, agentRunning: false, ...o });
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
  const plan: CompletionPlan = { workspaces: [ws('clean'), ws('dirty', { uncommitted: 1 }), ws('gone', { exists: false }), ws('unpushed', { unpushed: 4 }), ws('unknown', { uncommitted: null })], items: [item('x', 10), item('y', 20)] };
  expect(defaultChoice(plan)).toEqual({ removeWorktrees: ['clean', 'unpushed'], removeItems: ['x', 'y'], seen: { clean: 0, dirty: 1, gone: 0, unpushed: 0, unknown: null } });
});

test('choiceSummary', () => {
  const plan: CompletionPlan = { workspaces: [ws('a'), ws('b')], items: [item('x', 1024), item('y', 1024)] };
  expect(choiceSummary(plan, { removeWorktrees: ['a'], removeItems: ['x', 'y'], seen: {} })).toBe('작업 폴더 1개, 정리 대기 2건 (2.0KB)을(를) 지웁니다');
  expect(choiceSummary(plan, { removeWorktrees: [], removeItems: [], seen: {} })).toBe('아무것도 지우지 않습니다');
  // 목록에 없는 id 는 세지 않는다
  expect(choiceSummary(plan, { removeWorktrees: ['zzz'], removeItems: ['x'], seen: {} })).toBe('정리 대기 1건 (1.0KB)을(를) 지웁니다');
});

test('확인하지 못한 작업 폴더는 경고하고 기본으로 고르지 않는다. 무시 파일이 있으면 함께 지워진다고 알린다', () => {
  expect(worktreeRisk(ws('a', { uncommitted: null }))).toContain('확인하지 못했습니다');
  expect(ignoredNote(ws('a'))).toBeNull();
  expect(ignoredNote(ws('a', { ignored: 3 }))).toContain('3개');
  expect(ignoredNote(ws('a', { ignored: null }))).toContain('확인하지 못했습니다');
  expect(ignoredNote(ws('a', { exists: false, ignored: 3 }))).toBeNull();
});
