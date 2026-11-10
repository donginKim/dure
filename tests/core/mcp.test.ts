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
  const server = await startMcpServer({ workspaces, projects }, [workspaceTools]);
  return { server, project, front, back };
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
  const extra = await startMcpServer({ workspaces: undefined as never, projects: undefined as never }, []);
  await extra.close();
  await expect(fetch(extra.url, { method: 'POST' })).rejects.toThrow();
});
