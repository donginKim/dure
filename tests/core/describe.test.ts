import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { baseInstructions } from '@core/agents/instructions';
import type { Repo } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let repo: Repo;

async function call(workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}
const make = (name?: string) => core.service.create({ projectId, repoId: repo.id, name, baseBranch: 'main', agentKind: 'claude' });

beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  projectId = core.projects.create('쇼핑몰').id;
  repo = await core.addRepo(projectId, makeRepo('shop'));
});
afterEach(async () => { await core.dispose(); vi.useRealTimers(); });

describe('요약', () => {
  test('에이전트가 한 줄 요약을 갱신한다. 줄바꿈은 빼고 80자에서 자른다', async () => {
    const ws = await make('백엔드');
    expect(await call(ws.id, 'workspace_describe', { summary: '로그인 API\n만드는 중' })).toContain('로그인 API 만드는 중');
    expect(core.workspaces.get(ws.id)!.summary).toBe('로그인 API 만드는 중');
    await call(ws.id, 'workspace_describe', { summary: 'x'.repeat(200) });
    expect(core.workspaces.get(ws.id)!.summary.length).toBe(80);
    await call(ws.id, 'workspace_describe', { summary: '' });
    expect(core.workspaces.get(ws.id)!.summary).toBe('');
  });

  test('바뀌면 화면에 알린다. 다른 워크스페이스의 project_overview 에 요약이 보인다', async () => {
    const ws = await make('백엔드');
    const other = await make('프론트');
    const changed: string[] = [];
    core.service.on('changed', (id: string) => changed.push(id));
    await call(ws.id, 'workspace_describe', { summary: 'API 완성, 커밋 대기' });
    expect(changed).toEqual([ws.id]);
    expect(await call(other.id, 'project_overview')).toContain('API 완성, 커밋 대기');
  });
});

describe('자동 이름', () => {
  test('두레가 붙인 이름이면 에이전트가 바꿀 수 있다. 브랜치와 작업 폴더는 그대로다', async () => {
    const ws = await make();
    expect(ws).toMatchObject({ name: 'shop-1', nameLocked: false });
    const text = await call(ws.id, 'workspace_describe', { name: ' 로그인 화면 ', summary: '폼 만드는 중' });
    expect(text).toContain('로그인 화면');
    expect(core.workspaces.get(ws.id)).toMatchObject({ name: '로그인 화면', nameLocked: false, summary: '폼 만드는 중', branch: ws.branch, worktreePath: ws.worktreePath });
    expect(gitOut(repo.path, 'branch', '--list', ws.branch).trim()).toContain(ws.branch);
    // 바뀐 이름으로 메시지를 받을 수 있다
    const other = await make('백엔드');
    expect(await call(other.id, 'message_send', { to: '로그인 화면', body: 'API 준비됨' })).toContain('messageId');
  });

  test('사용자가 직접 지은 이름은 바꾸지 않고 이유를 알려 준다. 요약은 반영한다', async () => {
    const ws = await make('백엔드');
    expect(ws.nameLocked).toBe(true);
    const text = await call(ws.id, 'workspace_describe', { name: '다른 이름', summary: '하는 중' });
    expect(text).toContain('사용자가 직접 지은 이름');
    expect(core.workspaces.get(ws.id)).toMatchObject({ name: '백엔드', summary: '하는 중' });
  });

  test('겹치는 이름, 조율의 이름, 빈 이름으로는 바꾸지 않는다', async () => {
    await make('백엔드');
    const ws = await make();
    expect(await call(ws.id, 'workspace_describe', { name: '백엔드' })).toContain('이미 있는 워크스페이스 이름');
    expect(await call(ws.id, 'workspace_describe', { name: '조율' })).toContain('조율 에이전트의 이름');
    expect(await call(ws.id, 'workspace_describe', { name: '  ' })).toContain('이름이 비어');
    expect(core.workspaces.get(ws.id)!.name).toBe(ws.name);
    // 실패한 시도는 간격 제한에 들어가지 않는다
    expect(await call(ws.id, 'workspace_describe', { name: '로그인' })).toContain('\\"name\\":\\"로그인\\"');
  });

  test('너무 자주 바꾸지 못한다. 5분 뒤에는 다시 바꿀 수 있다', async () => {
    const ws = await make();
    await call(ws.id, 'workspace_describe', { name: '로그인' });
    expect(await call(ws.id, 'workspace_describe', { name: '로그인 화면' })).toContain('방금 바꿨다');
    expect(core.workspaces.get(ws.id)!.name).toBe('로그인');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6 * 60_000 });
    expect(core.service.describeByAgent(ws.id, { name: '로그인 화면' })).toEqual({ name: '로그인 화면' });
  });

  test('사용자가 이름을 바꾸면 고정된다. "자동 이름" 을 켜면 에이전트가 다시 바꿀 수 있다', async () => {
    const ws = await make();
    expect(core.service.rename(ws.id, ' 결제 ')).toMatchObject({ name: '결제', nameLocked: true });
    expect(await call(ws.id, 'workspace_describe', { name: '다른 것' })).toContain('사용자가 직접 지은 이름');
    expect(core.service.setAutoName(ws.id, true).nameLocked).toBe(false);
    expect(await call(ws.id, 'workspace_describe', { name: '결제 화면' })).toContain('\\"name\\":\\"결제 화면\\"');
    await make('백엔드');
    expect(() => core.service.rename(ws.id, '백엔드')).toThrow('이미 있는 워크스페이스 이름');
    expect(() => core.service.rename(ws.id, '조율')).toThrow('조율 에이전트의 이름');
    expect(() => core.service.rename(ws.id, ' ')).toThrow('이름이 비어');
    expect(core.service.rename(ws.id, 'x'.repeat(60)).name.length).toBe(40);
  });

  test('조율 에이전트에게는 이 도구가 없고, 이름을 바꿀 수 없다', async () => {
    const c = core.coordinator.ensure(projectId);
    expect(await call(c.id, 'workspace_describe', { summary: 'x' })).not.toContain('"summary"');
    expect(() => core.service.rename(c.id, '다른 이름')).toThrow('조율 에이전트에는');
    expect(() => core.service.describeByAgent(c.id, { summary: 'x' })).toThrow('조율 에이전트에는');
    expect(core.workspaces.get(c.id)!.name).toBe('조율');
  });

  test('완료된 프로젝트에서는 바꿀 수 없다', async () => {
    const ws = await make();
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [], seen: {} });
    expect(() => core.service.rename(ws.id, '새 이름')).toThrow('완료된 프로젝트');
    expect(() => core.service.describeByAgent(ws.id, { summary: 'x' })).toThrow('완료된 프로젝트');
  });

  test('지침: 임시 이름일 때만 이름을 바꾸라고 한다', async () => {
    const auto = await make();
    const named = await make('백엔드');
    const project = core.projects.get(projectId)!;
    expect(baseInstructions(auto, project)).toContain('두레가 임시로 붙인 것이다');
    expect(baseInstructions(named, project)).not.toContain('임시로 붙인');
    expect(baseInstructions(named, project)).toContain('workspace_describe');
  });
});
