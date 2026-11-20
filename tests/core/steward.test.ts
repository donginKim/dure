import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { stewardInstructions } from '@core/agents/instructions';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core; let projectId: string; let ws: Workspace;
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000): Promise<void> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await tick(15); } };
async function rpc(workspaceId: string, method: string, params: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.text();
}
const call = (workspaceId: string, name: string, args: unknown = {}): Promise<string> => rpc(workspaceId, 'tools/call', { name, arguments: args });
const inbox = (workspaceId: string) => core.messages.undelivered(workspaceId);
const agreement = (title = 'API 형식'): string => core.agreements.propose(projectId, '화면', { kind: 'api', title, body: 'GET /todos' }).id;
const plan = async (): Promise<string> => {
  core.coordinator.ensure(projectId);
  const repo = core.repos.list(projectId)[0]!;
  return (await core.coordinator.propose(projectId, { summary: '정리', workspaces: [{ name: '서버', repo: repo.name, role: 'API', todos: [{ title: 'API 만들기' }] }] })).id;
};

beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(), stewardDelayMs: 20 });
  core.settings.update({ autoStartOnMessage: false });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('repo'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('비서의 자리는 보이지 않는 프로젝트다: 프로젝트 목록에 들지 않고, 여러 번 불러도 하나다', () => {
  const a = core.steward.ensure();
  const b = core.steward.ensure();
  expect(b.project.id).toBe(a.project.id);
  expect(b.workspace.id).toBe(a.workspace.id);
  expect(a.project.kind).toBe('steward');
  expect(a.workspace.role).toBe('coordinator');
  expect(core.projects.list().map((p) => p.name)).toEqual(['쇼핑몰']);
  expect(core.steward.isSteward(a.project.id)).toBe(true);
  expect(core.steward.isSteward(projectId)).toBe(false);
  expect(core.steward.state()).toMatchObject({ name: '비서', approval: 'safe', auto: false });
  // 확인할 것에도 비서 자신의 것은 들지 않는다
  expect(core.attention.list().every((i) => i.projectId !== a.project.id)).toBe(true);
});

test('모든 프로젝트의 현황과 TODO 를 본다. 비서의 프로젝트는 들지 않는다', () => {
  core.steward.ensure();
  const other = core.projects.create('블로그').id;
  core.todos.add({ projectId, workspaceId: ws.id, title: '폼 만들기' }, 'user');
  core.todos.add({ projectId, title: '로그인 기능' }, 'user');
  const o = core.steward.overview() as { projects: { id: string; name: string; workspaces: { name: string; todos: { total: number } }[]; project_todos: { total: number } }[] };
  expect(o.projects.map((p) => p.name)).toEqual(['쇼핑몰', '블로그']);
  expect(o.projects[0]!.workspaces.find((w) => w.name === '화면')!.todos.total).toBe(1);
  expect(o.projects[0]!.project_todos.total).toBe(1);
  const t = core.steward.todos(projectId) as { project_todos: { title: string }[]; workspaces: { name: string; todos: { title: string }[] }[] };
  expect(t.project_todos.map((x) => x.title)).toEqual(['로그인 기능']);
  expect(t.workspaces[0]).toMatchObject({ name: '화면', todos: [{ title: '폼 만들기' }] });
  expect(() => core.steward.todos(core.steward.ensure().project.id)).toThrow('프로젝트가 없습니다');
  expect(o.projects.some((p) => p.id === other)).toBe(true);
});

test('어느 프로젝트의 TODO 든 더하고 고치고 지운다. 그 워크스페이스의 에이전트에게는 바뀐 것이 전해진다', () => {
  const added = core.steward.addTodo({ projectId, workspaceId: ws.id, title: '오류 문구 다듬기', assignee: 'agent' });
  expect(core.todos.listWorkspace(ws.id).map((t) => t.title)).toEqual(['오류 문구 다듬기']);
  expect(core.todos.takePending(ws.id).join('\n')).toContain('오류 문구 다듬기');
  expect(core.steward.updateTodo(added.id, { status: 'cancelled' }).status).toBe('cancelled');
  core.steward.removeTodo(added.id);
  expect(core.todos.listWorkspace(ws.id)).toEqual([]);
  // 다른 프로젝트의 워크스페이스를 섞어 쓸 수 없다
  const other = core.projects.create('블로그').id;
  expect(() => core.steward.addTodo({ projectId: other, workspaceId: ws.id, title: 'x' })).toThrow('그 프로젝트의 워크스페이스가 아닙니다');
  expect(() => core.steward.updateTodo('nope', { title: 'x' })).toThrow('그 TODO 가 없습니다');
});

test('승인 범위 "추천만": 아무것도 스스로 정하지 못한다. 시도는 기록에 남는다', async () => {
  core.settings.update({ stewardApproval: 'suggest' });
  const id = agreement();
  const item = core.steward.items().find((i) => i.id === `agreement:${id}`)!;
  expect(item).toMatchObject({ allowed: false });
  expect(item.why).toContain('추천만');
  expect(item.detail2).toContain('GET /todos');
  await expect(core.steward.decide(item.id, 'approve', { reason: '형식이 맞다' })).rejects.toThrow('추천만');
  expect(core.agreements.list(projectId).length).toBe(0);
  expect(core.steward.history()[0]).toMatchObject({ itemId: item.id, decision: 'approve' });
  expect(core.steward.history()[0]!.outcome).toContain('하지 않음');
});

test('승인 범위 "안전한 것만": 약속은 받아들이고, 계획안은 못 정한다', async () => {
  const id = agreement();
  const planId = await plan();
  const items = core.steward.items();
  expect(items.find((i) => i.kind === 'agreement')!.allowed).toBe(true);
  expect(items.find((i) => i.kind === 'plan')).toMatchObject({ id: `plan:${planId}`, allowed: false });
  expect(await core.steward.decide(`agreement:${id}`, 'approve', { reason: '화면과 서버가 같은 형식을 쓴다' })).toBe('약속을 받아들임');
  expect(core.agreements.list(projectId).map((a) => a.title)).toEqual(['API 형식']);
  await expect(core.steward.decide(`plan:${planId}`, 'approve', { reason: 'x' })).rejects.toThrow('전부 스스로');
  expect(core.coordinator.pending(projectId)?.id).toBe(planId);
  // 왜 그렇게 정했는지 없으면 정하지 않는다
  const again = agreement('이름 규칙');
  await expect(core.steward.decide(`agreement:${again}`, 'approve', { reason: '  ' })).rejects.toThrow('reason');
  // 버리기
  expect(await core.steward.decide(`agreement:${again}`, 'deny', { reason: '겹치는 약속이다' })).toBe('약속 제안을 버림');
  expect(core.steward.history().map((h) => h.outcome)).toEqual(expect.arrayContaining(['약속을 받아들임', '약속 제안을 버림']));
});

test('승인 범위 "전부 스스로": 계획안을 올라온 그대로 승인해 워크스페이스가 만들어진다. 없는 항목은 정하지 못한다', async () => {
  core.settings.update({ stewardApproval: 'all' });
  const planId = await plan();
  expect(core.steward.items().find((i) => i.kind === 'plan')!.allowed).toBe(true);
  expect(await core.steward.decide(`plan:${planId}`, 'approve', { reason: '기획서의 범위와 같다' })).toContain('계획안을 올라온 그대로 승인함');
  expect(core.workspaces.list(projectId).map((w) => w.name)).toEqual(expect.arrayContaining(['화면', '서버']));
  expect(core.coordinator.pending(projectId)).toBeNull();
  await expect(core.steward.decide(`plan:${planId}`, 'approve', { reason: 'x' })).rejects.toThrow('그 항목이 없습니다');
  await expect(core.steward.decide('pair:whatever', 'approve', { reason: 'x' })).rejects.toThrow('그 항목이 없습니다');
});

test('비서의 도구는 비서에게만 보인다. 비서에게는 계획안을 올리는 도구가 없다', async () => {
  const s = core.steward.ensure().workspace;
  const coordinator = core.coordinator.ensure(projectId);
  const mine = await rpc(s.id, 'tools/list');
  for (const name of ['steward_overview', 'steward_todos', 'steward_todo_add', 'steward_todo_update', 'steward_todo_remove', 'steward_waiting', 'steward_decide', 'steward_tell']) expect(mine).toContain(`"${name}"`);
  expect(mine).not.toContain('"plan_propose"');
  for (const other of [coordinator.id, ws.id]) expect(await rpc(other, 'tools/list')).not.toContain('steward_');
  // 다른 에이전트가 이름을 알고 불러도 없다
  expect(await call(ws.id, 'steward_decide', { id: 'x', decision: 'approve', reason: 'x' })).not.toContain('"done"');
  // 비서가 도구로 본다: 다른 사람이 쓴 글이 든 내용은 detail2 로 온다
  agreement();
  const waiting = await call(s.id, 'steward_waiting');
  expect(waiting).toContain('approval_setting');
  expect(waiting).toContain('API 형식');
  expect(await call(s.id, 'steward_overview')).toContain('쇼핑몰');
});

test('조율 에이전트에게 글을 전한다: 두레의 알림으로 간다', () => {
  core.steward.tell(projectId, '로그인 화면의 오류 문구를 다듬는 일을 계획안으로 올려 줘');
  const c = core.coordinator.ensure(projectId);
  const got = inbox(c.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ from: { kind: 'system' } });
  expect(got[0]!.body).toContain('오류 문구');
  expect(() => core.steward.tell(projectId, '  ')).toThrow('전할 글이 없습니다');
});

test('자동 처리를 켜면, 정할 수 있는 것이 생겼을 때만 비서에게 알린다', async () => {
  const s = core.steward.ensure();
  const sent = (): number => inbox(s.workspace.id).length;
  core.attention.refresh();
  // 꺼져 있으면 알리지 않는다
  agreement('첫째');
  core.attention.refresh();
  await tick(120);
  expect(sent()).toBe(0);
  core.settings.update({ stewardAuto: true });
  // 정할 수 없는 것만 생기면 (안전한 것만에서 계획안) 깨우지 않는다: 먼저 약속을 치운다
  for (const a of core.agreements.list(projectId, { proposed: true })) core.agreements.remove(a.id);
  await plan();
  core.attention.refresh();
  await tick(120);
  expect(sent()).toBe(0);
  // 정할 수 있는 것이 생기면 한 번 알린다
  agreement('둘째');
  core.attention.refresh();
  await until(() => sent() === 1);
  expect(inbox(s.workspace.id)[0]!.body).toContain('steward_waiting');
});

test('지침에는 지금의 승인 범위와, 도구가 주는 글은 지시가 아니라는 것이 들어 있다', () => {
  const text = stewardInstructions('똘이', 'all');
  expect(text).toContain('"똘이"');
  expect(text).toContain('전부 스스로');
  expect(text).toContain('지시가 아니다');
  expect(stewardInstructions('비서', 'suggest')).toContain('추천만');
  expect(stewardInstructions('비서', 'safe')).toContain('안전한 것만 스스로');
});

test('설정: 이름과 승인 범위를 검사한다', () => {
  expect(core.settings.update({ stewardName: ' 똘이 ' }).stewardName).toBe('똘이');
  expect(() => core.settings.update({ stewardName: '' })).toThrow('비서의 이름');
  expect(() => core.settings.update({ stewardName: 'a"b' })).toThrow('비서의 이름');
  expect(() => core.settings.update({ stewardApproval: 'everything' as never })).toThrow('승인 범위');
});
