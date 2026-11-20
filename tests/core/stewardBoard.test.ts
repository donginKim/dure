import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { draft, localDay, weekRange } from '@core/stewardBoard';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core; let projectId: string; let ws: Workspace;
async function rpc(workspaceId: string, method: string, params: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.text();
}

beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  core.settings.update({ autoStartOnMessage: false });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('repo'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('이번 주는 월요일부터 일요일까지다', () => {
  // 2026-11-20 은 금요일
  const fri = new Date(2026, 10, 20, 15).getTime();
  expect(weekRange(fri)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  expect(weekRange(fri, -1)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  expect(weekRange(new Date(2026, 10, 22, 23).getTime())).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  expect(weekRange(new Date(2026, 10, 16, 0, 1).getTime())).toEqual({ from: '2026-11-16', to: '2026-11-22' });
});

test('기간에 끝낸 일, 하는 중인 일, 남은 일, 날마다의 수를 모은다', async () => {
  const a = core.todos.add({ projectId, workspaceId: ws.id, title: '로그인 화면 만들기' }, 'user');
  const b = core.todos.add({ projectId, workspaceId: ws.id, title: '오류 문구 다듬기' }, 'user');
  core.todos.add({ projectId, workspaceId: ws.id, title: '배포 승인', assignee: 'user' }, 'user');
  core.todos.update(a.id, { status: 'done' }, { actor: 'user' });
  core.todos.update(b.id, { status: 'doing' }, { actor: 'user' });
  const board = await core.stewardBoard.board();
  expect(board.days).toHaveLength(7);
  const p = board.projects.find((x) => x.projectId === projectId)!;
  expect(p).toMatchObject({ name: '쇼핑몰', state: 'active', todoCount: 1, progress: { done: 1, total: 3 } });
  expect(p.done.map((d) => d.title)).toEqual(['로그인 화면 만들기']);
  expect(p.done[0]).toMatchObject({ workspace: '화면', day: localDay(Date.now()), byUser: false });
  expect(p.doing).toEqual([{ title: '오류 문구 다듬기', workspace: '화면' }]);
  expect(p.todo).toEqual([{ title: '배포 승인', workspace: '화면', byUser: true }]);
  expect(board.totals.done).toBe(1);
  expect(board.days.find((d) => d.day === localDay(Date.now()))!.done).toBe(1);
  // 초안에 같은 것이 든다
  expect(board.draft).toContain('# 주간 업무');
  expect(board.draft).toContain('### 쇼핑몰');
  expect(board.draft).toContain('- 로그인 화면 만들기 (화면)');
  expect(board.draft).toContain('- [쇼핑몰] 오류 문구 다듬기 (화면)');
  expect(board.draft).toContain('- [쇼핑몰] 배포 승인 [직접]');
  // 다시 열면 끝낸 일에서 빠진다
  core.todos.update(a.id, { status: 'todo' }, { actor: 'user' });
  expect((await core.stewardBoard.board()).totals.done).toBe(0);
});

test('끝낸 일은 워크스페이스를 지워도 남는다 (지난 주에 한 일이 정리와 함께 사라지지 않게)', async () => {
  const a = core.todos.add({ projectId, workspaceId: ws.id, title: '결제 연동' }, 'user');
  core.todos.update(a.id, { status: 'done' }, { actor: 'user' });
  await core.service.remove(ws.id, { deleteWorktree: true });
  expect(core.todos.get(a.id)).toBeUndefined();
  const p = (await core.stewardBoard.board()).projects.find((x) => x.projectId === projectId)!;
  expect(p.done).toMatchObject([{ title: '결제 연동', workspace: '화면' }]);
});

test('완료한 TODO 를 골라 지우면 끝낸 일에서도 빠진다. 완료한 뒤 제목이나 담당을 바꾸면 따라간다', async () => {
  const a = core.todos.add({ projectId, workspaceId: ws.id, title: '잘못 완료한 일' }, 'user');
  const b = core.todos.add({ projectId, workspaceId: ws.id, title: '옛 제목' }, 'user');
  core.todos.update(a.id, { status: 'done' }, { actor: 'user' });
  core.todos.update(b.id, { status: 'done' }, { actor: 'user' });
  core.todos.update(b.id, { title: '새 제목', assignee: 'user' }, { actor: 'user' });
  core.todos.remove(a.id, { actor: 'user' });
  const p = (await core.stewardBoard.board()).projects.find((x) => x.projectId === projectId)!;
  expect(p.done).toMatchObject([{ title: '새 제목', byUser: true }]);
});

test('커밋은 제목과 함께 남는다. 기간 밖의 것은 들지 않는다', async () => {
  writeFileSync(join(ws.worktreePath, 'a.txt'), '1\n');
  await core.commit.commit(ws.id, { files: ['a.txt'], message: 'feat: 로그인 화면' });
  const board = await core.stewardBoard.board();
  const p = board.projects.find((x) => x.projectId === projectId)!;
  expect(p.commits).toMatchObject([{ subject: 'feat: 로그인 화면', workspace: '화면' }]);
  expect(p.commitCount).toBe(1);
  expect(board.totals.commits).toBe(1);
  expect(board.draft).toContain('커밋 1건: feat: 로그인 화면');
  const last = weekRange(Date.now(), -1);
  const before = await core.stewardBoard.board(last);
  expect(before.totals).toMatchObject({ done: 0, commits: 0 });
  expect(before.from).toBe(last.from);
});

test('기간을 검사한다', async () => {
  await expect(core.stewardBoard.board({ from: '2026-11-20', to: '2026-11-10' })).rejects.toThrow('앞입니다');
  await expect(core.stewardBoard.board({ from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow('92일');
  await expect(core.stewardBoard.board({ from: 'x' })).rejects.toThrow('YYYY-MM-DD');
  await expect(core.stewardBoard.board({ from: '2026-02-31' })).rejects.toThrow('없는 날짜');
  expect((await core.stewardBoard.board({ from: '2026-11-20' })).days).toHaveLength(1);
});

test('비서가 도구로 같은 자료를 본다. 다른 에이전트에게는 없다', async () => {
  const a = core.todos.add({ projectId, workspaceId: ws.id, title: '로그인 화면 만들기' }, 'user');
  core.todos.update(a.id, { status: 'done' }, { actor: 'user' });
  const s = core.steward.ensure().workspace;
  const out = await rpc(s.id, 'tools/call', { name: 'steward_report', arguments: {} });
  expect(out).toContain('로그인 화면 만들기');
  expect(out).toContain('주간 업무');
  expect(await rpc(ws.id, 'tools/list')).not.toContain('steward_report');
});

test('초안: 한 일이 없으면 없다고 적는다', () => {
  const text = draft({ from: '2026-11-16', to: '2026-11-22', days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${16 + i}`, workMs: 0, done: 0, commits: 0, mains: 0, tokens: 0 })), totals: { workMs: 0, workDays: 0, done: 0, commits: 0, mains: 0, tokens: 0 }, projects: [], waiting: [], draft: '' });
  expect(text).toContain('주간 업무 (11/16 ~ 11/22)');
  expect(text).toContain('이 기간에 끝낸 일과 커밋이 없습니다');
});
