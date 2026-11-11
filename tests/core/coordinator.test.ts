import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Repo } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

const SIZE = { cols: 100, rows: 30 };
let core: Core;
let dataDir: string;
let fakeBin: string;
let projectId: string;
let front: Repo;
let back: Repo;

const until = (cond: () => boolean, ms = 6000): Promise<void> => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = (): void => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : void setTimeout(tick, 20));
  tick();
});

// 실제와 같은 모양의 JSON 줄을 내는 가짜 Claude Code. 받은 인자와 말을 적어 둔다.
const FAKE = `
const fs = require('node:fs'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
const dir = path.dirname(argv[argv.indexOf('--settings') + 1]);
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify({ argv, cwd: process.cwd(), path: process.env.PATH }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const hook = (ev, body) => { try { execFileSync(path.join(dir, 'hook.sh'), [ev], { input: JSON.stringify(body ?? {}), encoding: 'utf8' }); } catch {} };
out({ type: 'system', subtype: 'init', session_id: 's-1' });
hook('SessionStart', { source: 'startup' });
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  if (m.type !== 'user') return;
  fs.appendFileSync(path.join(dir, 'said.log'), JSON.stringify(m.message.content) + '\\n');
  hook('UserPromptSubmit', { prompt: m.message.content }); hook('Stop'); out({ type: 'result', subtype: 'success' });
});
`;
const cfg = (id: string, file: string): string => join(dataDir, 'workspaces', id, file);
const said = (id: string): string[] => (existsSync(cfg(id, 'said.log')) ? readFileSync(cfg(id, 'said.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string) : []);
const launch = (id: string): { argv: string[]; cwd: string; path: string } => JSON.parse(readFileSync(cfg(id, 'argv.log'), 'utf8').trim().split('\n')[0]!);

async function rpc(workspaceId: string, method: string, params: unknown = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, text: await res.text() };
}
const call = (workspaceId: string, name: string, args: unknown = {}) => rpc(workspaceId, 'tools/call', { name, arguments: args });

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  fakeBin = join(tempDir(), 'bin');
  mkdirSync(fakeBin);
  const js = join(fakeBin, 'fake.js');
  writeFileSync(js, FAKE);
  writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${js}' "$@"\n`);
  chmodSync(join(fakeBin, 'claude'), 0o755);
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  projectId = core.projects.create('쇼핑몰').id;
  const frontPath = makeRepo('shop-front');
  gitOut(frontPath, 'branch', 'develop');
  front = await core.addRepo(projectId, frontPath);
  back = await core.addRepo(projectId, makeRepo('shop-back'));
});
afterEach(async () => { await core.dispose(); });

describe('조율 에이전트', () => {
  test('프로젝트마다 하나 만들어지고, 보통 워크스페이스 목록과 저장소 목록에는 보이지 않는다', () => {
    const a = core.coordinator.ensure(projectId);
    expect(core.coordinator.ensure(projectId).id).toBe(a.id);
    expect(a).toMatchObject({ role: 'coordinator', name: '조율', agentKind: 'claude', engine: 'chat', status: 'stopped' });
    expect(a.worktreePath).toBe(join(dataDir, 'coordinators', projectId));
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(core.workspaces.listAll(projectId).map((w) => w.id)).toEqual([a.id]);
    expect(core.workspaces.coordinator(projectId)?.id).toBe(a.id);
    expect(core.repos.list(projectId).map((r) => r.name)).toEqual(['shop-front', 'shop-back']);
    expect(() => core.coordinator.ensure('없는-id')).toThrow('프로젝트가 없습니다');
  });

  test('두레의 폴더에서, 파일을 고치는 도구 없이, 등록된 저장소를 읽을 수 있게 뜬다', async () => {
    const c = core.coordinator.ensure(projectId);
    expect(await core.service.startAgent(c.id, SIZE)).toBeNull();
    await until(() => core.workspaces.get(c.id)?.status === 'idle');
    const l = launch(c.id);
    expect(l.cwd.endsWith(join('coordinators', projectId))).toBe(true);
    expect(l.argv[l.argv.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,MultiEdit,NotebookEdit');
    const dirs = l.argv.flatMap((a, i) => (a === '--add-dir' ? [l.argv[i + 1]] : []));
    expect(dirs).toEqual([front.path, back.path]);
    expect(l.argv.join(' ')).toContain('조율 에이전트');
    // 저장소가 아니므로 commit·push 를 막는 대리 파일은 걸지 않는다
    expect(l.path.startsWith(join(dataDir, 'workspaces', c.id, 'bin'))).toBe(false);
  });

  test('보통 워크스페이스는 그대로다: 파일을 고칠 수 있고 대리 파일이 걸린다', async () => {
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    await core.service.startAgent(ws.id, SIZE);
    await until(() => core.workspaces.get(ws.id)?.status === 'idle');
    const l = launch(ws.id);
    expect(l.argv).not.toContain('--disallowedTools');
    expect(l.argv).not.toContain('--add-dir');
    expect(l.path.startsWith(join(dataDir, 'workspaces', ws.id, 'bin'))).toBe(true);
    expect(l.argv.join(' ')).toContain('조율이 일을 시키면');
  });
});

describe('워크스페이스 제안', () => {
  test('저장소는 이름으로 받고, 기준 브랜치를 비우면 그 저장소의 현재 브랜치다. 승인 전에는 아무것도 만들어지지 않는다', async () => {
    const p = await core.coordinator.propose(projectId, [
      { name: '로그인 화면', repo: 'shop-front', base_branch: 'develop', role: '로그인 폼과 화면 흐름' },
      { name: '로그인 API', repo: 'shop-back', role: '인증 API' },
    ], '프론트와 백엔드로 나눴다');
    expect(p).toMatchObject({ status: 'pending', note: '프론트와 백엔드로 나눴다' });
    expect(p.items).toEqual([
      { name: '로그인 화면', repoId: front.id, baseBranch: 'develop', role: '로그인 폼과 화면 흐름' },
      { name: '로그인 API', repoId: back.id, baseBranch: 'main', role: '인증 API' },
    ]);
    expect(core.coordinator.pending(projectId)?.id).toBe(p.id);
    expect(core.workspaces.list(projectId)).toEqual([]);
  });

  test('등록되지 않은 저장소, 없는 브랜치, 빈 이름이 있으면 올리지 않고 이유를 알려 준다', async () => {
    await expect(core.coordinator.propose(projectId, [{ name: 'x', repo: 'nope', role: '' }], '')).rejects.toThrow('등록된 저장소가 아니다');
    await expect(core.coordinator.propose(projectId, [{ name: 'x', repo: 'nope', role: '' }], '')).rejects.toThrow('shop-front, shop-back');
    await expect(core.coordinator.propose(projectId, [{ name: 'x', repo: 'shop-front', base_branch: 'nope', role: '' }], '')).rejects.toThrow('브랜치 nope 가 없다');
    await expect(core.coordinator.propose(projectId, [{ name: ' ', repo: 'shop-front', role: '' }], '')).rejects.toThrow('이름이 없다');
    await expect(core.coordinator.propose(projectId, [], '')).rejects.toThrow('제안할 워크스페이스가 없다');
    await expect(core.coordinator.propose(projectId, 'x', '')).rejects.toThrow();
    expect(core.coordinator.pending(projectId)).toBeNull();
  });

  test('새로 제안하면 앞의 미결 제안은 사라진다', async () => {
    const a = await core.coordinator.propose(projectId, [{ name: 'a', repo: 'shop-front', role: '' }], '');
    const b = await core.coordinator.propose(projectId, [{ name: 'b', repo: 'shop-back', role: '' }], '');
    expect(core.coordinator.pending(projectId)?.id).toBe(b.id);
    await expect(core.coordinator.approve(a.id, a.items)).rejects.toThrow('승인을 기다리는 제안이 아닙니다.');
  });

  test('승인하면 사용자가 고친 최종 목록대로 만들고, 맡을 일을 한 줄 요약으로 남기고, 조율 에이전트에게 알린다', async () => {
    const c = core.coordinator.ensure(projectId);
    const p = await core.coordinator.propose(projectId, [
      { name: '로그인 화면', repo: 'shop-front', role: '로그인 폼' }, { name: '로그인 API', repo: 'shop-back', role: '인증 API' },
    ], '');
    // 사용자가 화면에서 하나를 빼고, 이름과 브랜치를 고쳤다
    const created = await core.coordinator.approve(p.id, [{ name: '로그인', repoId: front.id, baseBranch: 'develop', role: '폼과 흐름' }]);
    expect(created.map((w) => [w.name, w.baseBranch, w.summary, w.engine])).toEqual([['로그인', 'develop', '폼과 흐름', 'chat']]);
    expect(core.workspaces.list(projectId).map((w) => w.name)).toEqual(['로그인']);
    expect(existsSync(created[0]!.worktreePath)).toBe(true);
    expect(core.coordinator.pending(projectId)).toBeNull();
    // 조율 에이전트는 꺼져 있었다: 이 알림으로 뜨고, 최종 목록을 받는다
    await until(() => said(c.id).some((t) => t.includes('승인했다')), 8000);
    const told = said(c.id).find((t) => t.includes('승인했다'))!;
    expect(told).toContain('"로그인"');
    expect(told).not.toContain('로그인 API');
  });

  test('이름이 겹치거나 이미 있는 이름이면 아무것도 만들지 않는다. 제안은 그대로 기다린다', async () => {
    await core.service.create({ projectId, repoId: front.id, name: '이미 있음', baseBranch: 'main', agentKind: 'claude' });
    const p = await core.coordinator.propose(projectId, [{ name: 'a', repo: 'shop-front', role: '' }], '');
    await expect(core.coordinator.approve(p.id, [{ name: '같음', repoId: front.id, baseBranch: 'main', role: '' }, { name: '같음', repoId: back.id, baseBranch: 'main', role: '' }])).rejects.toThrow('이름이 겹칩니다');
    await expect(core.coordinator.approve(p.id, [{ name: '새것', repoId: front.id, baseBranch: 'main', role: '' }, { name: '이미 있음', repoId: back.id, baseBranch: 'main', role: '' }])).rejects.toThrow('이미 있는 워크스페이스 이름');
    await expect(core.coordinator.approve(p.id, [{ name: 'x', repoId: 'nope', baseBranch: 'main', role: '' }])).rejects.toThrow('등록된 저장소가 아니다');
    await expect(core.coordinator.approve(p.id, [])).rejects.toThrow('만들 워크스페이스가 없습니다');
    expect(core.workspaces.list(projectId).map((w) => w.name)).toEqual(['이미 있음']);
    expect(core.coordinator.pending(projectId)?.id).toBe(p.id);
  });

  test('다른 프로젝트의 저장소로는 만들 수 없다', async () => {
    const other = core.projects.create('다른 것');
    const foreign = await core.addRepo(other.id, makeRepo('foreign'));
    const p = await core.coordinator.propose(projectId, [{ name: 'a', repo: 'shop-front', role: '' }], '');
    await expect(core.coordinator.approve(p.id, [{ name: 'a', repoId: foreign.id, baseBranch: 'main', role: '' }])).rejects.toThrow('등록된 저장소가 아니다');
    await expect(core.coordinator.propose(projectId, [{ name: 'a', repo: foreign.path, role: '' }], '')).rejects.toThrow('등록된 저장소가 아니다');
  });

  test('거절하면 만들어지지 않고, 이유가 조율 에이전트에게 전해진다', async () => {
    const c = core.coordinator.ensure(projectId);
    const p = await core.coordinator.propose(projectId, [{ name: 'a', repo: 'shop-front', role: '' }], '');
    core.coordinator.reject(p.id, '백엔드는 필요 없다');
    expect(core.coordinator.pending(projectId)).toBeNull();
    expect(core.workspaces.list(projectId)).toEqual([]);
    await until(() => said(c.id).some((t) => t.includes('거절했다') && t.includes('백엔드는 필요 없다')), 8000);
    expect(() => core.coordinator.reject(p.id)).toThrow('승인을 기다리는 제안이 아닙니다.');
  });
});

describe('조율 에이전트의 도구', () => {
  test('제안 도구와 다른 워크스페이스에 TODO 를 적는 도구는 조율 에이전트에게만 있다', async () => {
    const c = core.coordinator.ensure(projectId);
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    const forCoordinator = (await rpc(c.id, 'tools/list')).text;
    expect(forCoordinator).toContain('workspace_propose');
    expect(forCoordinator).toContain('todo_assign');
    const forWorker = (await rpc(ws.id, 'tools/list')).text;
    expect(forWorker).not.toContain('workspace_propose');
    expect(forWorker).not.toContain('todo_assign');
    expect(forWorker).toContain('todo_add');
    // 보통 워크스페이스가 도구 이름을 알아도 부를 수 없다
    expect((await call(ws.id, 'workspace_propose', { items: [{ name: 'x', repo: 'shop-front', role: '' }] })).text).not.toContain('"proposed"');
    expect(core.coordinator.pending(projectId)).toBeNull();
  });

  test('workspace_propose 로 올린 제안이 화면에 뜨고, 문제가 있으면 이유를 돌려받는다', async () => {
    const c = core.coordinator.ensure(projectId);
    expect((await call(c.id, 'workspace_propose', { items: [{ name: '로그인', repo: 'nope', role: 'x' }] })).text).toContain('등록된 저장소가 아니다');
    expect((await call(c.id, 'workspace_propose', { items: [{ name: '로그인', repo: 'shop-front', role: '폼' }], note: '하나면 된다' })).text).toContain('승인을 기다린다');
    expect(core.coordinator.pending(projectId)).toMatchObject({ note: '하나면 된다', items: [{ name: '로그인', repoId: front.id }] });
  });

  test('조율 에이전트의 todo_add 는 프로젝트 범위, todo_assign 은 그 워크스페이스의 항목이 된다', async () => {
    const c = core.coordinator.ensure(projectId);
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    await call(c.id, 'todo_add', { title: '기획서 검토' });
    await call(c.id, 'todo_assign', { workspace: '프론트', title: '로그인 폼 만들기', assignee: 'agent' });
    expect((await call(c.id, 'todo_assign', { workspace: '없는 것', title: 'x' })).text).toContain('라는 워크스페이스가 없다');
    const all = core.todos.listProject(projectId);
    expect(all.map((t) => [t.title, t.workspaceId])).toEqual(expect.arrayContaining([['기획서 검토', null], ['로그인 폼 만들기', ws.id]]));
    expect(all.length).toBe(2);
    // 조율 에이전트는 프로젝트 범위의 항목을 읽고 고칠 수 있고, 워크스페이스의 항목은 고칠 수 없다
    expect((await call(c.id, 'todo_list')).text).toContain('기획서 검토');
    const mine = all.find((t) => t.workspaceId === null)!;
    const theirs = all.find((t) => t.workspaceId === ws.id)!;
    expect((await call(c.id, 'todo_update', { id: mine.id, rev: mine.rev, status: 'done' })).text).toContain('done');
    expect((await call(c.id, 'todo_update', { id: theirs.id, rev: theirs.rev, status: 'done' })).text).toContain('프로젝트 범위의 항목만');
    expect(core.todos.get(theirs.id)?.status).toBe('todo');
  });

  test('조율 에이전트의 project_overview 에는 저장소의 브랜치가 있고, 워크스페이스는 조율 에이전트에게 메시지를 보낼 수 있다', async () => {
    const c = core.coordinator.ensure(projectId);
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    const overview = (await call(c.id, 'project_overview')).text;
    expect(overview).toContain('develop');
    expect(overview).toContain('currentBranch');
    expect((await call(ws.id, 'project_overview')).text).not.toContain('currentBranch');
    expect((await call(ws.id, 'project_overview')).text).toContain('조율 에이전트');
    const sent = (await call(ws.id, 'message_send', { to: '조율', body: '로그인 폼 끝났다' })).text;
    expect(sent).toContain('messageId');
    await until(() => said(c.id).some((t) => t.includes('> 로그인 폼 끝났다')), 8000);
  });
});

describe('프로젝트를 닫을 때', () => {
  test('완료 처리하면 조율 에이전트도 꺼지고, 완료된 프로젝트에서는 시작할 수 없다', async () => {
    const c = core.coordinator.ensure(projectId);
    await core.service.startAgent(c.id, SIZE);
    await until(() => core.workspaces.get(c.id)?.status === 'idle');
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [], seen: {} });
    expect(core.service.isAgentRunning(c.id)).toBe(false);
    await expect(core.service.startAgent(c.id, SIZE)).rejects.toThrow('완료된 프로젝트입니다');
    // 조율 에이전트의 폴더는 작업 폴더가 아니다: 완료 처리의 지울 것 목록에 나오지 않는다
    expect((await core.completionPlan(projectId)).workspaces).toEqual([]);
  });

  test('프로젝트를 완전히 지우면 조율 에이전트와 그 폴더도 지워진다. 등록했던 저장소는 그대로다', async () => {
    const c = core.coordinator.ensure(projectId);
    await core.removeProject(projectId);
    expect(core.workspaces.get(c.id)).toBeUndefined();
    expect(existsSync(c.worktreePath)).toBe(false);
    expect(existsSync(front.path)).toBe(true);
  });
});
