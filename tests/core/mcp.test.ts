import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '@core/db';
import { startMcpServer } from '@core/mcp/server';
import { workspaceTools } from '@core/mcp/tools/workspace';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import type { AgentKind } from '@shared/types';

async function setup() {
  const db = openDatabase(':memory:');
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const workspaces = new WorkspaceStore(db);
  const project = projects.create('쇼핑몰');
  const repo = repos.add(project.id, '/tmp/shop');
  const add = (name: string, token: string, agentKind: AgentKind) => workspaces.insert({
    id: crypto.randomUUID(), projectId: project.id, repoId: repo.id, name, nameLocked: true, branch: `dure/${name}`,
    baseBranch: 'main', worktreePath: `/tmp/wt/${name}`, agentKind, permissionMode: 'ask', token,
  });
  const front = add('프론트', 'tok-front', 'claude');
  const back = add('백엔드', 'tok-back', 'codex');
  const other = repos.add(project.id, '/tmp/shop-api');
  const hookCalls: { ws: string; event: string; payload: unknown }[] = [];
  const onHook = (w: { name: string }, event: string, payload: unknown): string => { hookCalls.push({ ws: w.name, event, payload }); return event === 'Stop' ? '{"decision":"block","reason":"r"}' : ''; };
  const server = await startMcpServer({ workspaces, projects, repos, todos: undefined as never, messages: undefined as never, delivery: undefined as never, commitDrafts: undefined as never, cleanup: undefined as never, coordinator: undefined as never, dbs: undefined as never, slack: undefined as never, notes: undefined as never, notesForAgents: () => false, notesWriteForAgents: () => false, browser: undefined as never, peers: { remoteWorkspaces: () => [], people: () => [], assignable: () => [] } as never, assignments: undefined as never, describe: () => ({}), git: undefined as never, onHook }, [workspaceTools]);
  return { server, project, front, back, repo, other, hookCalls };
}

async function connect(url: string, token: string) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function whoami(url: string, token: string) {
  const client = await connect(url, token);
  const res = await client.callTool({ name: 'workspace_whoami', arguments: {} });
  await client.close();
  return JSON.parse((res.content as { type: string; text: string }[])[0].text);
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.server.close(); });

test('올바른 토큰이면 도구 목록에 workspace_whoami 가 있다', async () => {
  const client = await connect(ctx.server.url, 'tok-front');
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain('workspace_whoami');
  await client.close();
});

test('workspace_whoami 는 토큰의 워크스페이스와 프로젝트를 돌려준다', async () => {
  expect(await whoami(ctx.server.url, 'tok-front')).toEqual({
    workspaceId: ctx.front.id, workspaceName: '프론트', projectId: ctx.project.id, projectName: '쇼핑몰', agentKind: 'claude',
  });
});

test('서로 다른 토큰은 서로 다른 워크스페이스로 답한다', async () => {
  const [a, b] = await Promise.all([whoami(ctx.server.url, 'tok-front'), whoami(ctx.server.url, 'tok-back')]);
  expect(a.workspaceId).toBe(ctx.front.id);
  expect(b).toMatchObject({ workspaceId: ctx.back.id, workspaceName: '백엔드', agentKind: 'codex' });
});

test('토큰이 없거나 틀리면 401', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  expect((await fetch(ctx.server.url, { method: 'POST', headers, body })).status).toBe(401);
  expect((await fetch(ctx.server.url, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body })).status).toBe(401);
});

test('/mcp 가 아닌 경로는 404', async () => {
  const res = await fetch(ctx.server.url.replace('/mcp', '/other'), { headers: { Authorization: 'Bearer tok-front' } });
  expect(res.status).toBe(404);
});

test('서버는 127.0.0.1 에만 묶이고 url 이 그 포트를 가리킨다', () => {
  expect(ctx.server.url).toBe(`http://127.0.0.1:${ctx.server.port}/mcp`);
  expect(ctx.server.address).toBe('127.0.0.1');
});

test('close 뒤에는 접속이 거부된다', async () => {
  const extra = await startMcpServer({ workspaces: undefined as never, projects: undefined as never, repos: undefined as never, todos: undefined as never, messages: undefined as never, delivery: undefined as never, commitDrafts: undefined as never, cleanup: undefined as never, coordinator: undefined as never, dbs: undefined as never, slack: undefined as never, notes: undefined as never, notesForAgents: () => false, notesWriteForAgents: () => false, browser: undefined as never, peers: { remoteWorkspaces: () => [], people: () => [], assignable: () => [] } as never, assignments: undefined as never, describe: () => ({}), git: undefined as never, onHook: () => '' }, []);
  await extra.close();
  await expect(fetch(extra.url, { method: 'POST' })).rejects.toThrow();
});

test('project_overview 는 프로젝트의 모든 저장소와 워크스페이스를 알려준다', async () => {
  const client = await connect(ctx.server.url, 'tok-front');
  const res = await client.callTool({ name: 'project_overview', arguments: {} });
  await client.close();
  const out = JSON.parse((res.content as { type: string; text: string }[])[0].text);
  expect(out.project).toEqual({ id: ctx.project.id, name: '쇼핑몰' });
  // 워크스페이스가 없는 저장소도 나와야 한다: 에이전트가 같은 프로젝트의 다른 저장소를 알 수 있어야 한다
  expect(out.repos).toEqual([
    { name: 'shop', path: '/tmp/shop', workspaceCount: 2 },
    { name: 'shop-api', path: '/tmp/shop-api', workspaceCount: 0 },
  ]);
  expect(out.workspaces).toEqual([
    { name: '프론트', repo: 'shop', branch: 'dure/프론트', path: '/tmp/wt/프론트', agent: 'claude', status: 'stopped', isMe: true },
    { name: '백엔드', repo: 'shop', branch: 'dure/백엔드', path: '/tmp/wt/백엔드', agent: 'codex', status: 'stopped', isMe: false },
  ]);
});

const hookUrl = (event: string) => ctx.server.url.replace('/mcp', `/hook/${event}`);

test('POST /hook/Stop 은 토큰이 맞으면 200 과 onHook 의 반환값을 돌려준다', async () => {
  const res = await fetch(hookUrl('Stop'), { method: 'POST', headers: { Authorization: 'Bearer tok-back' }, body: JSON.stringify({ a: 1 }) });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"decision":"block","reason":"r"}');
  expect(ctx.hookCalls).toEqual([{ ws: '백엔드', event: 'Stop', payload: { a: 1 } }]);
});

test('POST /hook/Stop 은 토큰이 없으면 401', async () => {
  expect((await fetch(hookUrl('Stop'), { method: 'POST', body: '{}' })).status).toBe(401);
  expect(ctx.hookCalls).toEqual([]);
});

test('hook 본문이 JSON 이 아니어도 200 이다', async () => {
  const res = await fetch(hookUrl('PreToolUse'), { method: 'POST', headers: { Authorization: 'Bearer tok-front' }, body: 'not json' });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('');
  expect(ctx.hookCalls[0]).toEqual({ ws: '프론트', event: 'PreToolUse', payload: 'not json' });
});

test('서버는 hook 주소를 알려준다', () => {
  expect(ctx.server.hookUrl).toBe(`http://127.0.0.1:${ctx.server.port}/hook`);
});
