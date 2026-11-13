import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { MAX_SPEC_BYTES } from '@core/coordinator';
import type { ProposalItem, Repo } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

const SIZE = { cols: 100, rows: 30 };
let core: Core;
let dataDir: string;
let fakeBin: string;
let repoRoot: string;
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
  repoRoot = join(tempDir(), 'new repos');
  core = await createCore({ dataDir, repoRoot, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
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
    // 원본 저장소에 닿으므로 파일을 바꾸는 명령을 저절로 허용하지 않고, 등록된 저장소의 commit·push 를 막는 대리 파일을 건다
    expect(l.argv[l.argv.indexOf('--permission-mode') + 1]).toBe('default');
    expect(l.path.startsWith(join(dataDir, 'workspaces', c.id, 'bin'))).toBe(true);
    const shim = readFileSync(join(dataDir, 'workspaces', c.id, 'bin', 'git'), 'utf8');
    expect(shim).toContain(join(realpathSync(front.path), '.git'));
    expect(shim).toContain(join(realpathSync(back.path), '.git'));
  });

  test('보통 워크스페이스는 그대로다: 파일을 고칠 수 있고 대리 파일이 걸린다', async () => {
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    await core.service.startAgent(ws.id, SIZE);
    await until(() => core.workspaces.get(ws.id)?.status === 'idle');
    const l = launch(ws.id);
    expect(l.argv).not.toContain('--disallowedTools');
    expect(l.argv[l.argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(l.argv).not.toContain('--add-dir');
    expect(l.path.startsWith(join(dataDir, 'workspaces', ws.id, 'bin'))).toBe(true);
    expect(l.argv.join(' ')).toContain('조율이 일을 시키면');
  });
});

const W = (name: string, repo: string, o: Record<string, unknown> = {}) => ({ name, repo, role: '', todos: [], ...o });
const item = (o: Partial<ProposalItem> & { name: string; repoId: string }): ProposalItem => ({ baseBranch: 'main', role: '', todos: [], existing: false, ...o });
const todo = (title: string, assignee: 'agent' | 'user' = 'agent') => ({ title, detail: '', assignee });

describe('계획안', () => {
  test('정리, 워크스페이스, TODO 를 한 번에 올린다. 승인 전에는 아무것도 만들어지지 않는다', async () => {
    const p = await core.coordinator.propose(projectId, {
      summary: '# 로그인\n이메일 로그인을 만든다',
      workspaces: [
        W('로그인 화면', 'shop-front', { base_branch: 'develop', role: '로그인 폼과 화면 흐름', todos: [{ title: '폼 만들기', detail: '이메일, 비밀번호' }, '검증 붙이기'] }),
        W('로그인 API', 'shop-back', { role: '인증 API', todos: [{ title: 'POST /login' }] }),
      ],
      project_todos: [{ title: '세션 방식 정하기', assignee: 'user' }],
      note: '프론트와 백엔드로 나눴다',
    });
    expect(p).toMatchObject({ status: 'pending', summary: '# 로그인\n이메일 로그인을 만든다', note: '프론트와 백엔드로 나눴다' });
    expect(p.items).toEqual([
      { name: '로그인 화면', repoId: front.id, baseBranch: 'develop', role: '로그인 폼과 화면 흐름', existing: false, owner: '', todos: [{ title: '폼 만들기', detail: '이메일, 비밀번호', assignee: 'agent' }, todo('검증 붙이기')] },
      { name: '로그인 API', repoId: back.id, baseBranch: 'main', role: '인증 API', existing: false, owner: '', todos: [todo('POST /login')] },
    ]);
    expect(p.projectTodos).toEqual([todo('세션 방식 정하기', 'user')]);
    expect(core.coordinator.pending(projectId)?.id).toBe(p.id);
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(core.todos.listProject(projectId)).toEqual([]);
  });

  test('문제가 있으면 올리지 않고 이유를 알려 준다', async () => {
    const bad = (workspaces: unknown, more: Record<string, unknown> = {}) => core.coordinator.propose(projectId, { summary: '', workspaces, ...more });
    await expect(bad([W('x', 'nope')])).rejects.toThrow('등록된 저장소가 아니다');
    await expect(bad([W('x', 'nope')])).rejects.toThrow('shop-front, shop-back');
    await expect(bad([W('x', 'shop-front', { base_branch: 'nope' })])).rejects.toThrow('브랜치 nope 가 없다');
    await expect(bad([W(' ', 'shop-front')])).rejects.toThrow('이름이 없다');
    await expect(bad([W('a', 'shop-front'), W('a', 'shop-back')])).rejects.toThrow('이름이 겹친다');
    await expect(bad([W('조율', 'shop-front')])).rejects.toThrow('조율 에이전트의 이름');
    await expect(bad([W('a', 'shop-front', { todos: [{ title: ' ' }] })])).rejects.toThrow('제목이 없는 TODO');
    await expect(bad(Array.from({ length: 21 }, (_, i) => W(`w${i}`, 'shop-front')))).rejects.toThrow('20개까지');
    await expect(bad([])).rejects.toThrow('계획안이 비어 있다');
    await expect(bad('x')).rejects.toThrow('계획안이 비어 있다');
    expect(core.coordinator.pending(projectId)).toBeNull();
  });

  test('이미 있는 워크스페이스의 이름이면 만들지 않고 TODO 만 더하는 항목이 된다', async () => {
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('프론트', 'nope', { todos: ['버튼 고치기'] })] });
    expect(p.items).toMatchObject([{ name: '프론트', repoId: front.id, existing: true, todos: [todo('버튼 고치기')] }]);
    const res = await core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
    expect(res).toEqual({ assigned: 0, repos: [], created: [], todos: 1 });
    expect(core.workspaces.list(projectId).map((w) => w.id)).toEqual([ws.id]);
    expect(core.todos.listProject(projectId).map((t) => [t.title, t.workspaceId])).toEqual([['버튼 고치기', ws.id]]);
  });

  test('새로 올리면 앞의 미결 계획안은 사라진다', async () => {
    const a = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('a', 'shop-front')] });
    const b = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('b', 'shop-back')] });
    expect(core.coordinator.pending(projectId)?.id).toBe(b.id);
    await expect(core.coordinator.approve(a.id, { items: a.items, projectTodos: [] })).rejects.toThrow('승인을 기다리는 계획안이 아닙니다.');
  });

  test('워크스페이스의 TODO 는 under 로 프로젝트 TODO 에 딸리고, 다 끝나면 프로젝트 TODO 가 완료된다', async () => {
    core.coordinator.ensure(projectId);
    // 없는 프로젝트 TODO 를 가리키면 올리지 못한다
    await expect(core.coordinator.propose(projectId, {
      summary: '정리', workspaces: [W('로그인 화면', 'shop-front', { todos: [{ title: '폼', under: '없는 일' }] })], project_todos: ['로그인 기능'],
    })).rejects.toThrow('"없는 일" 라는 프로젝트 TODO 가 없다');
    const p = await core.coordinator.propose(projectId, {
      summary: '정리', project_todos: ['로그인 기능', { title: '배포 승인', assignee: 'user' }],
      workspaces: [
        W('로그인 화면', 'shop-front', { todos: [{ title: '폼', under: '로그인 기능' }, '정리']}),
        W('로그인 API', 'shop-back', { todos: [{ title: 'API', under: '로그인 기능' }] }),
      ],
    });
    expect(p.items[0]!.todos.map((t) => t.under)).toEqual(['로그인 기능', undefined]);
    const res = await core.coordinator.approve(p.id, { items: p.items, projectTodos: p.projectTodos });
    expect(res.todos).toBe(5);
    const all = core.todos.listProject(projectId);
    const big = all.find((t) => t.title === '로그인 기능')!;
    expect(all.filter((t) => t.parentId === big.id).map((t) => t.title).sort()).toEqual(['API', '폼']);
    expect(all.find((t) => t.title === '정리')!.parentId).toBeNull();
    for (const t of all.filter((x) => x.parentId === big.id)) core.todos.update(t.id, { status: 'done' }, { actor: 'user' });
    expect(core.todos.get(big.id)!.status).toBe('done');
    expect(all.find((t) => t.title === '배포 승인')!.status).toBe('todo');
  });

  test('계획안의 after 로 워크스페이스 사이의 순서를 건다. 앞의 일이 끝나면 그 워크스페이스에 알린다', async () => {
    core.coordinator.ensure(projectId);
    // 없는 TODO, 돌고 도는 순서는 받지 않는다
    await expect(core.coordinator.propose(projectId, { summary: 's', workspaces: [W('화면', 'shop-front', { todos: [{ title: 'API 붙이기', after: ['없는 일'] }] })] })).rejects.toThrow('"없는 일" 라는 TODO 가 이 계획안에 없다');
    await expect(core.coordinator.propose(projectId, { summary: 's', workspaces: [W('a', 'shop-front', { todos: [{ title: 'x', after: ['y'] }, { title: 'y', after: ['x'] }] })] })).rejects.toThrow('돌고 돈다');
    const p = await core.coordinator.propose(projectId, {
      summary: 's',
      workspaces: [
        W('로그인 화면', 'shop-front', { todos: ['폼 만들기', { title: 'API 붙이기', after: ['POST /login'] }] }),
        W('로그인 API', 'shop-back', { todos: ['POST /login'] }),
      ],
    });
    const res = await core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
    const all = core.todos.listProject(projectId);
    const api = all.find((t) => t.title === 'POST /login')!;
    const hook = all.find((t) => t.title === 'API 붙이기')!;
    expect(hook.after).toEqual([api.id]);
    expect(all.find((t) => t.title === '폼 만들기')!.after).toEqual([]);
    const front = res.created.find((w) => w.name === '로그인 화면')!;
    // 앞의 일이 끝나면 화면 워크스페이스에 알린다
    core.todos.update(api.id, { status: 'done' }, { actor: 'user' });
    const told = core.messages.undelivered(front.id).map((m) => m.body).join('\n');
    expect(told).toContain('앞의 일이 끝났다 (워크스페이스 "로그인 API"): "POST /login". 이제 "API 붙이기" 을(를) 시작할 수 있다');
  });

  test('일부만 고쳐 달라기: 계획안은 남기고, 사용자가 고친 지금의 모양과 말을 조율 에이전트에게 보낸다', async () => {
    const c = core.coordinator.ensure(projectId);
    const p = await core.coordinator.propose(projectId, { summary: 's', project_todos: ['로그인 기능'], workspaces: [W('로그인 화면', 'shop-front', { todos: [{ title: '폼', under: '로그인 기능' }] }), W('로그인 API', 'shop-back', { todos: ['POST /login'] })] });
    // 사용자가 검토 화면에서 이름을 고친 뒤, API 부분만 다시 짜 달라고 한다
    const edited = { items: p.items.map((it) => (it.name === '로그인 화면' ? { ...it, name: '로그인 페이지' } : it)), projectTodos: p.projectTodos };
    core.coordinator.requestRevision(p.id, 'API 를 둘로 나눠 줘', { target: '로그인 API', decision: edited });
    expect(core.coordinator.pending(projectId)!.id).toBe(p.id);
    const told = core.messages.undelivered(c.id).map((m) => m.body).join('\n');
    expect(told).toContain('"로그인 API" 부분을 고쳐 달라고 했다');
    expect(told).toContain('사용자의 말: API 를 둘로 나눠 줘');
    expect(told).toContain('"로그인 페이지"');
    expect(told).toContain('"under": "로그인 기능"');
    expect(() => core.coordinator.requestRevision(p.id, '  ')).toThrow('무엇을 어떻게 고칠지');
    core.coordinator.reject(p.id);
    expect(() => core.coordinator.requestRevision(p.id, 'x')).toThrow('승인을 기다리는 계획안이 아닙니다');
  });

  test('승인하면 사용자가 고친 최종 계획대로 워크스페이스와 TODO 를 만들고, 조율 에이전트에게 알린다', async () => {
    core.settings.update({ defaultPermissionMode: 'bypass' });
    const c = core.coordinator.ensure(projectId);
    const p = await core.coordinator.propose(projectId, {
      summary: '정리', workspaces: [W('로그인 화면', 'shop-front', { role: '로그인 폼', todos: ['폼'] }), W('로그인 API', 'shop-back', { role: '인증 API', todos: ['API'] })],
    });
    // 사용자가 검토 화면에서 하나를 빼고, 이름·브랜치·TODO 를 고치고, 프로젝트 TODO 를 더했다
    const res = await core.coordinator.approve(p.id, {
      items: [item({ name: '로그인', repoId: front.id, baseBranch: 'develop', role: '폼과 흐름', todos: [todo('폼 만들기'), todo('커밋하기', 'user')] })],
      projectTodos: [todo('세션 방식 정하기', 'user')],
    });
    expect(res.todos).toBe(3);
    // 설정의 기본 권한이 "승인 생략" 이어도 승인으로 만든 것은 "승인 필요" 다
    expect(res.created.map((w) => [w.name, w.baseBranch, w.summary, w.engine, w.permissionMode])).toEqual([['로그인', 'develop', '폼과 흐름', 'chat', 'ask']]);
    expect(core.workspaces.list(projectId).map((w) => w.name)).toEqual(['로그인']);
    expect(existsSync(res.created[0]!.worktreePath)).toBe(true);
    const made = res.created[0]!.id;
    expect(core.todos.listProject(projectId).map((t) => [t.title, t.workspaceId, t.assignee])).toEqual(expect.arrayContaining([
      ['폼 만들기', made, 'agent'], ['커밋하기', made, 'user'], ['세션 방식 정하기', null, 'user'],
    ]));
    expect(core.todos.listProject(projectId).length).toBe(3);
    expect(core.coordinator.pending(projectId)).toBeNull();
    // 조율 에이전트는 꺼져 있었다: 이 알림으로 뜨고, 최종 목록을 받는다
    await until(() => said(c.id).some((t) => t.includes('승인했다')), 8000);
    const told = said(c.id).find((t) => t.includes('승인했다'))!;
    expect(told).toContain('"로그인"');
    expect(told).toContain('폼 만들기');
    expect(told).toContain('다시 적지 마라');
    expect(told).not.toContain('로그인 API');
  });

  test('승인할 수 없는 계획이면 아무것도 만들지 않는다. 계획안은 그대로 기다린다', async () => {
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('a', 'shop-front')] });
    const ap = (items: ProposalItem[]) => core.coordinator.approve(p.id, { items, projectTodos: [] });
    await expect(ap([item({ name: '같음', repoId: front.id }), item({ name: '같음', repoId: back.id })])).rejects.toThrow('이름이 겹친다');
    await expect(ap([item({ name: 'x', repoId: 'nope' })])).rejects.toThrow('등록된 저장소가 아니다');
    await expect(ap([item({ name: 'x', repoId: front.id, baseBranch: 'nope' })])).rejects.toThrow('브랜치 nope 가 없다');
    await expect(ap(Array.from({ length: 21 }, (_, i) => item({ name: `w${i}`, repoId: front.id })))).rejects.toThrow('20개까지');
    await expect(ap([])).rejects.toThrow('만들 것이 없습니다');
    await expect(core.coordinator.approve(p.id, null as never)).rejects.toThrow('만들 것이 없습니다');
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(core.coordinator.pending(projectId)?.id).toBe(p.id);
  });

  test('다른 프로젝트의 저장소로는 만들 수 없다', async () => {
    const other = core.projects.create('다른 것');
    const foreign = await core.addRepo(other.id, makeRepo('foreign'));
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('a', 'shop-front')] });
    await expect(core.coordinator.approve(p.id, { items: [item({ name: 'a', repoId: foreign.id })], projectTodos: [] })).rejects.toThrow('등록된 저장소가 아니다');
    await expect(core.coordinator.propose(projectId, { summary: '', workspaces: [W('a', foreign.path)] })).rejects.toThrow('등록된 저장소가 아니다');
  });

  test('같은 계획안을 동시에 두 번 승인해도 한 벌만 만든다', async () => {
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('로그인', 'shop-front', { todos: ['폼'] })] });
    const d = { items: p.items, projectTodos: [] };
    const res = await Promise.allSettled([core.coordinator.approve(p.id, d), core.coordinator.approve(p.id, d)]);
    expect(res.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('이미 처리하는 중입니다.');
    const all = core.workspaces.list(projectId);
    expect(all.map((w) => w.name)).toEqual(['로그인']);
    expect(existsSync(all[0]!.worktreePath)).toBe(true);
    expect(core.todos.listProject(projectId).length).toBe(1);
    // 만드는 중에는 새 계획안도 거절도 받지 않는다
    const q = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('둘', 'shop-back')] });
    const going = core.coordinator.approve(q.id, { items: q.items, projectTodos: [] });
    await expect(core.coordinator.propose(projectId, { summary: '', workspaces: [W('셋', 'shop-back')] })).rejects.toThrow('만드는 중이다');
    expect(() => core.coordinator.reject(q.id)).toThrow('이미 처리하는 중입니다.');
    await going;
  });

  test('만드는 도중에 실패하면 만든 워크스페이스, 브랜치, TODO 를 되돌린다. 계획안은 그대로 기다린다', async () => {
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('하나', 'shop-front', { todos: ['a', 'b'] }), W('둘', 'shop-back', { todos: ['c'] })] });
    const real = core.todos.add.bind(core.todos);
    let n = 0;
    const spy = vi.spyOn(core.todos, 'add').mockImplementation((...args) => { if (++n === 3) throw new Error('디스크가 가득 찼습니다'); return real(...args); });
    await expect(core.coordinator.approve(p.id, { items: p.items, projectTodos: [] })).rejects.toThrow('디스크가 가득 찼습니다');
    spy.mockRestore();
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(core.todos.listProject(projectId)).toEqual([]);
    expect(gitOut(front.path, 'branch', '--list', 'dure/*').trim()).toBe('');
    expect(gitOut(back.path, 'branch', '--list', 'dure/*').trim()).toBe('');
    expect(core.coordinator.pending(projectId)?.id).toBe(p.id);
    // 다시 승인하면 된다
    const res = await core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
    expect(res.created.map((w) => w.name)).toEqual(['하나', '둘']);
    expect(res.todos).toBe(3);
  });

  test('되돌리지 못한 것이 있으면 무엇이 남았는지 알려 준다', async () => {
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('하나', 'shop-front', { todos: ['a'] })] });
    const add = vi.spyOn(core.todos, 'add').mockImplementation(() => { throw new Error('실패'); });
    const discard = vi.spyOn(core.service, 'discard').mockRejectedValue(new Error('지울 수 없음'));
    await expect(core.coordinator.approve(p.id, { items: p.items, projectTodos: [] })).rejects.toThrow('남은 것: 워크스페이스 하나');
    add.mockRestore(); discard.mockRestore();
  });

  test('거절하면 만들어지지 않고, 이유가 조율 에이전트에게 전해진다', async () => {
    const c = core.coordinator.ensure(projectId);
    const p = await core.coordinator.propose(projectId, { summary: '', workspaces: [W('a', 'shop-front', { todos: ['x'] })] });
    core.coordinator.reject(p.id, '백엔드는 필요 없다');
    expect(core.coordinator.pending(projectId)).toBeNull();
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(core.todos.listProject(projectId)).toEqual([]);
    await until(() => said(c.id).some((t) => t.includes('거절했다') && t.includes('백엔드는 필요 없다')), 8000);
    expect(() => core.coordinator.reject(p.id)).toThrow('승인을 기다리는 계획안이 아닙니다.');
  });

  test('기획서 파일: 글 파일은 내용을, 아닌 파일은 경로만 돌려준다', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'spec.md'), '# 로그인\n- 이메일');
    expect(core.coordinator.readSpec(join(dir, 'spec.md'))).toEqual({ path: join(dir, 'spec.md'), name: 'spec.md', text: '# 로그인\n- 이메일', truncated: false });
    writeFileSync(join(dir, 'spec.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
    expect(core.coordinator.readSpec(join(dir, 'spec.pdf'))).toMatchObject({ name: 'spec.pdf', text: null, truncated: false });
    writeFileSync(join(dir, 'big.md'), '가'.repeat(MAX_SPEC_BYTES));
    const big = core.coordinator.readSpec(join(dir, 'big.md'));
    expect(big.truncated).toBe(true);
    expect(big.text!.length).toBe(MAX_SPEC_BYTES / 3);
    expect(big.text!.endsWith('가')).toBe(true);
    expect(() => core.coordinator.readSpec('spec.md')).toThrow('파일을 찾을 수 없습니다');
    expect(() => core.coordinator.readSpec(dir)).toThrow('파일을 찾을 수 없습니다');
    expect(() => core.coordinator.readSpec(join(dir, 'none.md'))).toThrow();
  });
});

describe('새 저장소', () => {
  test('등록된 저장소가 없어도 계획안에 새 저장소를 넣을 수 있다. 승인하면 만들어 등록하고 그 위에 워크스페이스를 만든다', async () => {
    const empty = core.projects.create('빈 프로젝트').id;
    const c = core.coordinator.ensure(empty);
    const dir = core.coordinator.newRepoDir(empty);
    expect(dir.startsWith(repoRoot)).toBe(true);
    const p = await core.coordinator.propose(empty, {
      summary: '웹 하나', new_repos: [{ name: 'shop-web', description: '웹 사이트' }],
      workspaces: [W('웹', 'shop-web', { base_branch: 'develop', todos: ['첫 화면'] })],
    });
    expect(p.newRepos).toEqual([{ name: 'shop-web', description: '웹 사이트' }]);
    expect(p.items).toMatchObject([{ name: '웹', repoId: 'new:shop-web', baseBranch: 'main', existing: false }]);
    // 승인 전에는 폴더도 저장소도 없다
    expect(existsSync(join(dir, 'shop-web'))).toBe(false);
    expect(core.repos.list(empty)).toEqual([]);

    const res = await core.coordinator.approve(p.id, { newRepos: p.newRepos, items: p.items, projectTodos: [] });
    const path = join(dir, 'shop-web');
    expect(res.repos.map((r) => [r.name, r.path])).toEqual([['shop-web', path]]);
    expect(core.repos.list(empty).map((r) => r.name)).toEqual(['shop-web']);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# shop-web\n\n웹 사이트\n');
    expect(gitOut(path, 'rev-list', '--count', 'main')).toBe('1');
    expect(gitOut(path, 'status', '--porcelain')).toBe('');
    expect(gitOut(path, 'remote')).toBe('');
    expect(res.created.map((w) => [w.name, w.repoId, w.baseBranch])).toEqual([['웹', res.repos[0]!.id, 'main']]);
    expect(existsSync(join(res.created[0]!.worktreePath, 'README.md'))).toBe(true);
    expect(res.todos).toBe(1);
    await until(() => said(c.id).some((t) => t.includes('승인했다')), 8000);
    expect(said(c.id).find((t) => t.includes('승인했다'))).toContain(`새 저장소 "shop-web" (${path})`);
  });

  test('쓸 수 없는 이름, 겹치는 이름, 이미 폴더가 있는 자리는 올리지 않는다', async () => {
    const bad = (new_repos: unknown, workspaces: unknown = []) => core.coordinator.propose(projectId, { summary: '', new_repos, workspaces });
    for (const name of ['../x', 'a/b', '.git', '.hidden', '한글', 'a b', '', 'x.', '-x']) await expect(bad([{ name }])).rejects.toThrow('영문, 숫자');
    await expect(bad([{ name: 'web' }, { name: 'WEB' }])).rejects.toThrow('새 저장소 이름이 겹친다');
    await expect(bad([{ name: 'Shop-Front' }])).rejects.toThrow('이미 등록된 저장소의 이름');
    await expect(bad(Array.from({ length: 6 }, (_, i) => ({ name: `r${i}` })))).rejects.toThrow('5개까지');
    await expect(bad([{ name: 'web' }], [W('a', 'new:nope')])).rejects.toThrow('계획안에 없다');
    mkdirSync(join(core.coordinator.newRepoDir(projectId), 'taken'), { recursive: true });
    await expect(bad([{ name: 'taken' }])).rejects.toThrow('이미 폴더나 파일이 있다');
    expect(core.coordinator.pending(projectId)).toBeNull();
  });

  test('도중에 실패하면 새로 만든 저장소 폴더와 등록을 되돌린다. 다른 폴더는 건드리지 않는다', async () => {
    const dir = core.coordinator.newRepoDir(projectId);
    mkdirSync(join(dir, 'keep'), { recursive: true });
    writeFileSync(join(dir, 'keep', 'mine.txt'), 'x');
    const p = await core.coordinator.propose(projectId, { summary: '', new_repos: [{ name: 'api' }, { name: 'web' }], workspaces: [W('서버', 'api', { todos: ['a'] }), W('화면', 'web', { todos: ['b'] })] });
    const spy = vi.spyOn(core.todos, 'add').mockImplementation(() => { throw new Error('실패'); });
    await expect(core.coordinator.approve(p.id, { newRepos: p.newRepos, items: p.items, projectTodos: [] })).rejects.toThrow('실패');
    spy.mockRestore();
    expect(readdirSync(dir)).toEqual(['keep']);
    expect(readFileSync(join(dir, 'keep', 'mine.txt'), 'utf8')).toBe('x');
    expect(core.repos.list(projectId).map((r) => r.name)).toEqual(['shop-front', 'shop-back']);
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(core.coordinator.pending(projectId)?.id).toBe(p.id);
    // 다시 승인하면 된다
    const res = await core.coordinator.approve(p.id, { newRepos: p.newRepos, items: p.items, projectTodos: [] });
    expect(res.repos.map((r) => r.name)).toEqual(['api', 'web']);
    expect(res.created.map((w) => w.name)).toEqual(['서버', '화면']);
  });

  test('승인하는 사이에 그 자리에 폴더가 생겼으면 만들지 않고, 그 폴더를 지우지도 않는다', async () => {
    const p = await core.coordinator.propose(projectId, { summary: '', new_repos: [{ name: 'web' }], workspaces: [W('화면', 'web')] });
    const path = join(core.coordinator.newRepoDir(projectId), 'web');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'mine.txt'), 'x');
    await expect(core.coordinator.approve(p.id, { newRepos: p.newRepos, items: p.items, projectTodos: [] })).rejects.toThrow('이미 폴더나 파일이 있다');
    expect(readFileSync(join(path, 'mine.txt'), 'utf8')).toBe('x');
    // 사용자가 화면에서 새 저장소를 빼면, 그것을 쓰던 워크스페이스는 만들 수 없다
    await expect(core.coordinator.approve(p.id, { newRepos: [], items: p.items, projectTodos: [] })).rejects.toThrow('계획안에 없다');
  });

  test('그 자리에 끊어진 심볼릭 링크가 있어도 올리지 않는다. 전역 무시 규칙이 README 를 무시해도 만든다', async () => {
    const dir = core.coordinator.newRepoDir(projectId);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, 'nowhere'), join(dir, 'link'));
    await expect(core.coordinator.propose(projectId, { summary: '', new_repos: [{ name: 'link' }] })).rejects.toThrow('이미 폴더나 파일이 있다');
    const p = await core.coordinator.propose(projectId, { summary: '', new_repos: [{ name: 'web' }] });
    const res = await core.coordinator.approve(p.id, { newRepos: p.newRepos, items: [], projectTodos: [] });
    expect(gitOut(res.repos[0]!.path, 'rev-list', '--count', 'main')).toBe('1');
    expect(gitOut(res.repos[0]!.path, 'ls-files')).toBe('README.md');
  });

  test('plan_propose 도구로 새 저장소를 올릴 수 있다', async () => {
    const c = core.coordinator.ensure(projectId);
    const res = (await call(c.id, 'plan_propose', { summary: 's', new_repos: [{ name: 'infra', description: '봇 차단' }], workspaces: [{ name: '인프라', repo: 'infra', role: '', todos: [] }] })).text;
    expect(res).toContain('newRepos');
    expect(core.coordinator.pending(projectId)).toMatchObject({ newRepos: [{ name: 'infra', description: '봇 차단' }], items: [{ repoId: 'new:infra' }] });
  });
});

describe('조율 에이전트를 가두는 것', () => {
  test('이름이 "조율" 인 워크스페이스는 만들 수 없다', async () => {
    await expect(core.service.create({ projectId, repoId: front.id, name: ' 조율 ', baseBranch: 'main', agentKind: 'claude' })).rejects.toThrow('조율 에이전트의 이름');
    expect(core.workspaces.list(projectId)).toEqual([]);
    expect(gitOut(front.path, 'branch', '--list', 'dure/*').trim()).toBe('');
  });

  test('조율 에이전트는 지우거나, 방식을 바꾸거나, 셸을 열거나, 커밋할 수 없다', async () => {
    const c = core.coordinator.ensure(projectId);
    await expect(core.service.remove(c.id, { deleteWorktree: true })).rejects.toThrow('조율 에이전트에는 지울 수 없습니다');
    expect(() => core.service.setEngine(c.id, 'terminal')).toThrow('조율 에이전트에는');
    await expect(core.service.openShell(c.id, SIZE)).rejects.toThrow('조율 에이전트에는');
    await expect(core.commit.state(c.id)).rejects.toThrow('커밋할 저장소가 없습니다');
    await expect(core.commit.commit(c.id, { files: ['a'], message: 'x' })).rejects.toThrow('커밋할 저장소가 없습니다');
    await expect(core.commit.push(c.id)).rejects.toThrow('커밋할 저장소가 없습니다');
    expect(core.workspaces.coordinator(projectId)?.id).toBe(c.id);
  });

  test('전체 멈춤을 풀면 그동안 조율 에이전트에게 온 보고가 전달된다', async () => {
    const c = core.coordinator.ensure(projectId);
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    core.messages.pauseProject(projectId, true);
    expect((await call(ws.id, 'message_send', { to: '조율', body: '멈춘 동안의 보고' })).text).toContain('messageId');
    await new Promise((r) => setTimeout(r, 300));
    expect(said(c.id)).toEqual([]);
    core.messages.pauseProject(projectId, false);
    await until(() => said(c.id).some((t) => t.includes('> 멈춘 동안의 보고')), 8000);
  });

  test('완료된 프로젝트에서는 조율 에이전트를 새로 만들지 않는다', async () => {
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [], seen: {} });
    expect(() => core.coordinator.ensure(projectId)).toThrow('완료된 프로젝트입니다');
    expect(core.workspaces.coordinator(projectId)).toBeUndefined();
  });
});

describe('조율 에이전트의 도구', () => {
  test('계획안 도구와 다른 워크스페이스에 TODO 를 적는 도구는 조율 에이전트에게만 있다', async () => {
    const c = core.coordinator.ensure(projectId);
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    const forCoordinator = (await rpc(c.id, 'tools/list')).text;
    expect(forCoordinator).toContain('plan_propose');
    expect(forCoordinator).toContain('todo_assign');
    const forWorker = (await rpc(ws.id, 'tools/list')).text;
    expect(forWorker).not.toContain('plan_propose');
    expect(forWorker).not.toContain('todo_assign');
    expect(forWorker).toContain('todo_add');
    // 보통 워크스페이스가 도구 이름을 알아도 부를 수 없다
    await call(ws.id, 'plan_propose', { summary: '', workspaces: [{ name: 'x', repo: 'shop-front', role: '', todos: [] }] });
    expect(core.coordinator.pending(projectId)).toBeNull();
  });

  test('plan_propose 로 올린 계획안이 화면에 뜨고, 문제가 있으면 이유를 돌려받는다', async () => {
    const c = core.coordinator.ensure(projectId);
    expect((await call(c.id, 'plan_propose', { summary: 's', workspaces: [{ name: '로그인', repo: 'nope', role: 'x', todos: [] }] })).text).toContain('등록된 저장소가 아니다');
    const res = (await call(c.id, 'plan_propose', { summary: '로그인을 만든다', workspaces: [{ name: '로그인', repo: 'shop-front', role: '폼', todos: [{ title: '폼 만들기' }] }], project_todos: [{ title: '결정', assignee: 'user' }], note: '하나면 된다' })).text;
    expect(res).toContain('승인을 기다린다');
    expect(core.coordinator.pending(projectId)).toMatchObject({ summary: '로그인을 만든다', note: '하나면 된다', items: [{ name: '로그인', repoId: front.id, todos: [todo('폼 만들기')] }], projectTodos: [todo('결정', 'user')] });
    expect(core.workspaces.list(projectId)).toEqual([]);
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

describe('미뤄 둔 것 정리', () => {
  test('조율 에이전트의 todo_list 에 워크스페이스마다의 TODO 와 상태가 보인다. 보통 워크스페이스에는 보이지 않는다', async () => {
    const c = core.coordinator.ensure(projectId);
    const ws = await core.service.create({ projectId, repoId: front.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
    core.todos.add({ projectId, workspaceId: ws.id, title: '폼 만들기' }, 'agent');
    core.todos.add({ projectId, workspaceId: null, title: '세션 방식 정하기', assignee: 'user' }, 'agent');
    core.service.describeByAgent(ws.id, { summary: '폼 만드는 중' });
    const text = (await call(c.id, 'todo_list')).text;
    expect(text).toContain('\\"workspaces\\":[{\\"name\\":\\"프론트\\"');
    expect(text).toContain('폼 만들기');
    expect(text).toContain('폼 만드는 중');
    expect(text).toContain('세션 방식 정하기');
    expect((await call(ws.id, 'todo_list')).text).not.toContain('workspaces');
  });

  test('사용자가 프로젝트 TODO 를 바꾸면 조율 에이전트에게 전달된다. 조율 에이전트가 없으면 쌓지 않는다', async () => {
    const t = core.todos.add({ projectId, workspaceId: null, title: '포트 정하기', assignee: 'user' }, 'user');
    const c = core.coordinator.ensure(projectId);
    expect(core.todos.pendingCount(c.id)).toBe(0);
    core.todos.update(t.id, { title: '포트는 3000' }, { actor: 'user' });
    core.todos.add({ projectId, workspaceId: null, title: '배포는 안 한다' }, 'user');
    expect(core.todos.pendingCount(c.id)).toBe(2);
    const text = (await call(c.id, 'todo_list')).text;
    expect(text).toContain('(프로젝트 TODO)');
    expect(text).toContain('포트는 3000');
    expect(text).toContain('배포는 안 한다');
    expect(core.todos.pendingCount(c.id)).toBe(0);
    // 에이전트가 바꾼 것은 쌓지 않는다
    core.todos.add({ projectId, workspaceId: null, title: '조율이 적음' }, 'agent');
    expect(core.todos.pendingCount(c.id)).toBe(0);
  });

  test('새 저장소의 위치는 설정을 따른다', async () => {
    const custom = join(tempDir(), 'my repos');
    core.settings.update({ repoRoot: custom });
    expect(core.coordinator.newRepoDir(projectId).startsWith(custom)).toBe(true);
    const p = await core.coordinator.propose(projectId, { summary: '', new_repos: [{ name: 'web' }] });
    const res = await core.coordinator.approve(p.id, { newRepos: p.newRepos, items: [], projectTodos: [] });
    expect(res.repos[0]!.path.startsWith(custom)).toBe(true);
    expect(existsSync(join(res.repos[0]!.path, 'README.md'))).toBe(true);
    core.settings.update({ repoRoot: '' });
    expect(core.coordinator.newRepoDir(projectId).startsWith(repoRoot)).toBe(true);
  });

  test('저장소가 늘면 쉬는 중인 조율 에이전트를 다시 띄워 새 저장소를 읽게 한다. 대화는 이어진다', async () => {
    const c = core.coordinator.ensure(projectId);
    expect(await core.coordinator.reload(projectId)).toBe('off');
    await core.service.startAgent(c.id, SIZE);
    await until(() => core.workspaces.get(c.id)?.status === 'idle');
    const lines = (): { argv: string[] }[] => readFileSync(cfg(c.id, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines().length).toBe(1);
    const extra = makeRepo('shop-extra');
    await core.addRepo(projectId, extra);
    await until(() => lines().length === 2 && core.workspaces.get(c.id)?.status === 'idle', 8000);
    const argv = lines()[1]!.argv;
    expect(argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []))).toContain(extra);
    expect(argv).toContain('--resume');
  });

  test('계획안 승인으로 생긴 새 저장소도 조율 에이전트가 읽게 된다', async () => {
    const c = core.coordinator.ensure(projectId);
    await core.service.startAgent(c.id, SIZE);
    await until(() => core.workspaces.get(c.id)?.status === 'idle');
    const p = await core.coordinator.propose(projectId, { summary: '', new_repos: [{ name: 'web' }] });
    const res = await core.coordinator.approve(p.id, { newRepos: p.newRepos, items: [], projectTodos: [] });
    await until(() => said(c.id).some((t) => t.includes('승인했다')), 8000);
    const last = readFileSync(cfg(c.id, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] }).at(-1)!.argv;
    expect(last.flatMap((a, i) => (a === '--add-dir' ? [last[i + 1]] : []))).toContain(res.repos[0]!.path);
    expect(said(c.id).find((t) => t.includes('승인했다'))).not.toContain('껐다 켜');
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

describe('이미 있는 폴더를 저장소로 등록하기', () => {
  const W2 = (name: string, repo: string, o: Record<string, unknown> = {}) => ({ name, repo, role: '', todos: [], ...o });

  test('계획안에 PC 에 있는 저장소 폴더를 넣으면, 승인할 때 등록하고 거기에 워크스페이스를 만든다', async () => {
    const path = makeRepo('catalog-web');
    mkdirSync(join(path, 'api'));
    // 저장소 안의 하위 폴더를 적어도 저장소의 맨 위 폴더로 맞춘다
    const p = await core.coordinator.propose(projectId, { summary: '', add_repos: [{ path: join(path, 'api') }], workspaces: [W2('화면', 'catalog-web', { todos: ['목록'] }), W2('데이터', path)] });
    expect(p.addRepos).toEqual([{ path, name: 'catalog-web', remote: '' }]);
    expect(p.items.map((i) => [i.name, i.repoId, i.baseBranch])).toEqual([['화면', `path:${path}`, 'main'], ['데이터', `path:${path}`, 'main']]);
    // 승인 전에는 등록되지 않았다
    expect(core.repos.list(projectId).map((r) => r.name)).not.toContain('catalog-web');
    const res = await core.coordinator.approve(p.id, { addRepos: p.addRepos, items: p.items, projectTodos: [] });
    expect(res.repos.map((r) => r.path)).toEqual([path]);
    const repo = core.repos.list(projectId).find((r) => r.path === path)!;
    expect(res.created.map((w) => [w.name, w.repoId])).toEqual([['화면', repo.id], ['데이터', repo.id]]);
    expect(gitOut(path, 'branch', '--list', 'dure/*').split('\n').length).toBe(2);
  });

  test('git 저장소가 아니거나 없는 폴더, 상대 경로는 올리지 않는다. 이미 등록된 폴더는 그 저장소를 쓴다', async () => {
    const plain = tempDir();
    await expect(core.coordinator.propose(projectId, { add_repos: [{ path: plain }], workspaces: [] })).rejects.toThrow('git 저장소가 아니다');
    await expect(core.coordinator.propose(projectId, { add_repos: [{ path: join(plain, 'nope') }], workspaces: [] })).rejects.toThrow('그런 폴더가 없다');
    await expect(core.coordinator.propose(projectId, { add_repos: [{ path: 'relative/dir' }], workspaces: [] })).rejects.toThrow('절대 경로');
    const p = await core.coordinator.propose(projectId, { add_repos: [{ path: front.path }], workspaces: [W2('화면', front.path)] });
    expect(p.addRepos).toEqual([]);
    expect(p.items[0]!.repoId).toBe(front.id);
  });

  test('검토 화면에서 폴더를 뺐는데 그 저장소를 쓰는 워크스페이스가 남아 있으면 승인되지 않는다', async () => {
    const path = makeRepo('catalog-web');
    const p = await core.coordinator.propose(projectId, { add_repos: [{ path }], workspaces: [W2('화면', 'catalog-web')] });
    await expect(core.coordinator.approve(p.id, { addRepos: [], items: p.items, projectTodos: [] })).rejects.toThrow('등록할 저장소에 없다');
    expect(core.repos.list(projectId).some((r) => r.path === path)).toBe(false);
  });

  test('도중에 실패하면 등록만 푼다. 폴더는 건드리지 않는다', async () => {
    const path = makeRepo('catalog-web');
    const p = await core.coordinator.propose(projectId, { add_repos: [{ path }], workspaces: [W2('화면', 'catalog-web', { todos: ['목록'] })] });
    const spy = vi.spyOn(core.todos, 'add').mockImplementation(() => { throw new Error('실패'); });
    await expect(core.coordinator.approve(p.id, { addRepos: p.addRepos, items: p.items, projectTodos: [] })).rejects.toThrow('실패');
    spy.mockRestore();
    expect(core.repos.list(projectId).some((r) => r.path === path)).toBe(false);
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(gitOut(path, 'branch', '--list', 'dure/*')).toBe('');
    // 계획안은 그대로 기다리고, 다시 승인하면 된다
    const res = await core.coordinator.approve(p.id, { addRepos: p.addRepos, items: core.coordinator.pending(projectId)!.items, projectTodos: [] });
    expect(res.created.length).toBe(1);
  });
});
