import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { VerifyRunner } from '@core/verify';
import type { Repo, Workspace } from '@shared/types';
import { verifyLine } from '../../src/renderer/verifyView';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let repo: Repo;
let ws: Workspace;
let runs: { command: string; cwd: string; timeoutMs: number }[] = [];
let result: { code: number | null; output: string; timedOut: boolean } = { code: 0, output: 'ok', timedOut: false };
const runner: VerifyRunner = async (o) => { runs.push({ command: o.command, cwd: o.cwd, timeoutMs: o.timeoutMs }); return result; };

async function call(workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}

beforeEach(async () => {
  runs = [];
  result = { code: 0, output: 'ok', timedOut: false };
  core = await createCore({
    dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(),
    verifyRunner: runner,
  });
  projectId = core.projects.create('쇼핑몰').id;
  repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('확인 명령이 없으면 돌리지 않고 그대로 완료된다', async () => {
  const t = core.todos.add({ projectId, workspaceId: ws.id, title: 'API' }, 'agent');
  expect(await call(ws.id, 'todo_update', { id: t.id, rev: t.rev, status: 'done' })).toContain('done');
  expect(runs).toEqual([]);
  expect(core.verify.status(ws.id)).toBeNull();
});

test('에이전트가 TODO 를 완료로 바꾸면 확인 명령을 돌린다. 실패하면 완료를 받지 않고 출력을 돌려준다', async () => {
  core.verify.setCommand(repo.id, '  pnpm test  ');
  expect(core.repos.get(repo.id)!.verifyCommand).toBe('pnpm test');
  expect(core.verify.status(ws.id)).toMatchObject({ state: 'none', command: 'pnpm test' });
  const t = core.todos.add({ projectId, workspaceId: ws.id, title: 'API' }, 'agent');
  // 진행 중으로 바꾸는 것은 확인하지 않는다
  await call(ws.id, 'todo_update', { id: t.id, rev: t.rev, status: 'doing' });
  expect(runs).toEqual([]);
  result = { code: 1, output: 'FAIL src/api.test.ts\n  expected 200, got 500', timedOut: false };
  const failed = await call(ws.id, 'todo_update', { id: t.id, rev: 2, status: 'done' });
  expect(failed).toContain('확인 명령이 실패해 완료로 바꾸지 않았다');
  expect(failed).toContain('> FAIL src/api.test.ts');
  expect(failed).toContain('"isError":true');
  expect(runs).toEqual([{ command: 'pnpm test', cwd: ws.worktreePath, timeoutMs: 300_000 }]);
  expect(core.todos.get(t.id)!.status).toBe('doing');
  expect(core.verify.status(ws.id)).toMatchObject({ state: 'failed', output: 'FAIL src/api.test.ts\n  expected 200, got 500' });
  // 고친 뒤에는 통과하고 완료된다
  result = { code: 0, output: 'ok', timedOut: false };
  expect(await call(ws.id, 'todo_update', { id: t.id, rev: 2, status: 'done' })).toContain('\\"status\\":\\"done\\"');
  expect(core.todos.get(t.id)!.status).toBe('done');
  expect(core.verify.status(ws.id)).toMatchObject({ state: 'passed' });
  // 시간 제한에 걸리면 실패다
  const t2 = core.todos.add({ projectId, workspaceId: ws.id, title: '화면' }, 'agent');
  writeFileSync(join(ws.worktreePath, 'x.txt'), 'changed');
  result = { code: null, output: '', timedOut: true };
  expect(await call(ws.id, 'todo_update', { id: t2.id, rev: t2.rev, status: 'done' })).toContain('제한 시간 안에 끝나지 않아');
  expect(core.todos.get(t2.id)!.status).toBe('todo');
  // 처음부터 완료로 더하는 것도 확인을 거친다
  expect(await call(ws.id, 'todo_add', { title: '이미 한 일', status: 'done' })).toContain('완료로 바꾸지 않았다');
  expect(core.todos.listWorkspace(ws.id).map((x) => x.title)).toEqual(['API', '화면']);
});

test('작업 폴더가 지난번 통과한 때와 같으면 다시 돌리지 않는다. 바뀌면 다시 돌린다', async () => {
  core.verify.setCommand(repo.id, 'make check');
  const a = core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'agent');
  const b = core.todos.add({ projectId, workspaceId: ws.id, title: 'B' }, 'agent');
  const c = core.todos.add({ projectId, workspaceId: ws.id, title: 'C' }, 'agent');
  await call(ws.id, 'todo_update', { id: a.id, rev: a.rev, status: 'done' });
  await call(ws.id, 'todo_update', { id: b.id, rev: b.rev, status: 'done' });
  expect(runs.length).toBe(1);
  writeFileSync(join(ws.worktreePath, 'new.txt'), 'x');
  await call(ws.id, 'todo_update', { id: c.id, rev: c.rev, status: 'done' });
  expect(runs.length).toBe(2);
  // 사용자가 "지금 확인" 을 누르면 같아도 돌린다
  await core.verify.check(ws.id, { force: true });
  expect(runs.length).toBe(3);
  // 명령을 바꾸면 앞의 결과는 쓰지 않는다
  core.verify.setCommand(repo.id, 'make check2');
  expect(core.verify.status(ws.id)).toMatchObject({ state: 'none' });
  expect(await core.verify.check(ws.id)).toEqual({ ok: true, ran: true, reused: false });
  expect(runs.at(-1)!.command).toBe('make check2');
});

test('사용자가 화면에서 완료로 바꾸는 것은 확인하지 않는다. 겹쳐 돌리지 않는다. 확인 명령은 에이전트가 바꿀 수 없다', async () => {
  core.verify.setCommand(repo.id, 'pnpm test');
  result = { code: 1, output: 'x', timedOut: false };
  const t = core.todos.add({ projectId, workspaceId: ws.id, title: 'A' }, 'agent');
  core.todos.update(t.id, { status: 'done' }, { actor: 'user' });
  expect([core.todos.get(t.id)!.status, runs.length]).toEqual(['done', 0]);
  // 동시에 온 요청은 한 번만 돌리고 결과를 함께 받는다
  const [x, y] = await Promise.all([core.verify.check(ws.id), core.verify.check(ws.id)]);
  expect([x.ok, y.ok, runs.length]).toEqual([false, false, 1]);
  // 조율 에이전트의 프로젝트 TODO 는 확인과 상관없다
  const coordinator = core.coordinator.ensure(projectId);
  const p = core.todos.add({ projectId, title: '큰 일' }, 'agent');
  expect(await call(coordinator.id, 'todo_update', { id: p.id, rev: p.rev, status: 'done' })).toContain('done');
  // 에이전트의 도구에는 확인 명령을 바꾸는 것이 없다
  const tools = await (await fetch(core.mcpUrl, { method: 'POST', headers: { Authorization: `Bearer ${core.workspaces.getToken(ws.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text();
  expect(tools).not.toMatch(/"name":"[^"]*verify[^"]*"/i);
  // 잘못된 입력
  expect(() => core.verify.setCommand('nope', 'x')).toThrow('등록된 저장소가 아닙니다');
  expect(() => core.verify.setCommand(repo.id, 'x'.repeat(600))).toThrow('너무 깁니다');
  core.verify.setCommand(repo.id, '');
  expect(core.verify.status(ws.id)).toBeNull();
});

test('진짜 명령을 작업 폴더에서 돌린다: 종료 코드와 출력, 시간 제한', async () => {
  await core.dispose();
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  projectId = core.projects.create('쇼핑몰').id;
  repo = await core.addRepo(projectId, makeRepo('shop2'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
  core.verify.setCommand(repo.id, 'test -f marker.txt && echo found || { echo "no marker in $(basename "$PWD")" >&2; exit 3; }');
  const fail = await core.verify.check(ws.id);
  expect(fail).toMatchObject({ ok: false, timedOut: false });
  expect((fail as { output: string }).output).toContain('no marker in');
  writeFileSync(join(ws.worktreePath, 'marker.txt'), 'x');
  expect(await core.verify.check(ws.id)).toEqual({ ok: true, ran: true, reused: false });
  // 끝나지 않는 명령은 제한 시간에 멈춘다 (명령이 띄운 것까지)
  core.settings.update({ verifyTimeoutSec: 10 });
  core.verify.setCommand(repo.id, 'sleep 600');
  const started = Date.now();
  const slow = core.verify.check(ws.id, { force: true });
  expect(core.verify.status(ws.id)).toMatchObject({ state: 'running' });
  expect(await slow).toMatchObject({ ok: false, timedOut: true });
  expect(Date.now() - started).toBeLessThan(15_000);
}, 30_000);

test('verifyLine', () => {
  const s = { command: 'x', output: '', at: 0 };
  expect(verifyLine({ ...s, state: 'running' }, 0)).toBe('확인하는 중…');
  expect(verifyLine({ ...s, state: 'passed' }, 5 * 60_000)).toBe('확인 통과 · 5분 전');
  expect(verifyLine({ ...s, state: 'failed' }, 0)).toContain('확인 실패 · 방금');
  expect(verifyLine({ ...s, state: 'none' }, 0)).toContain('아직 확인한 적이 없습니다');
});

test('일의 순서: 앞의 일이 남았으면 도구가 까닭과 앞의 일을 알려 주고, todo_list 에 기다림이 보인다', async () => {
  const back = await core.service.create({ projectId, repoId: repo.id, name: 'API', baseBranch: 'main', agentKind: 'claude' });
  const api = core.todos.add({ projectId, workspaceId: back.id, title: 'POST /login' }, 'agent');
  const ui = core.todos.add({ projectId, workspaceId: ws.id, title: 'API 붙이기', after: [api.id] }, 'agent');
  const r = await call(ws.id, 'todo_update', { id: ui.id, rev: ui.rev, status: 'doing' });
  expect(r).toContain('아직 시작할 수 없다');
  expect(r).toContain('POST /login');
  expect(r).toContain('워크스페이스 \\"API\\"');
  const list = await call(ws.id, 'todo_list');
  expect(list).toContain('\\"waiting\\":true');
  core.todos.update(api.id, { status: 'done' }, { actor: 'user' });
  expect(await call(ws.id, 'todo_list')).not.toContain('\\"waiting\\":true');
  expect(await call(ws.id, 'todo_update', { id: ui.id, rev: ui.rev, status: 'doing' })).toContain('\\"status\\":\\"doing\\"');
});
