import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '@core/db';
import { startMcpServer } from '@core/mcp/server';
import { todoTools } from '@core/mcp/tools/todo';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import { TodoService } from '@core/todos';

async function setup() {
  const db = openDatabase(':memory:');
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const workspaces = new WorkspaceStore(db);
  const todos = new TodoService(db);
  const p = projects.create('쇼핑몰');
  const r = repos.add(p.id, '/tmp/shop');
  const mk = (name: string) => workspaces.insert({
    id: crypto.randomUUID(), projectId: p.id, repoId: r.id, name, nameLocked: true, branch: `dure/${name}`, baseBranch: 'main',
    worktreePath: `/tmp/wt/${name}`, agentKind: 'claude', permissionMode: 'ask', token: `tok-${name}`,
  });
  const front = mk('front');
  const back = mk('back');
  const server = await startMcpServer({ workspaces, projects, repos, todos, messages: undefined as never, delivery: undefined as never, commitDrafts: undefined as never, cleanup: undefined as never, coordinator: undefined as never, dbs: undefined as never, slack: undefined as never, notes: undefined as never, prs: undefined as never, notesForAgents: () => false, notesWriteForAgents: () => false, browser: undefined as never, peers: { remoteWorkspaces: () => [], people: () => [], assignable: () => [] } as never, assignments: { board: () => null, outgoing: () => [] } as never, describe: () => ({}), git: undefined as never, onHook: () => '' }, [todoTools]);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: 'Bearer tok-front' } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0].text;
    return { isError: res.isError === true, text, json: () => JSON.parse(text) };
  };
  return { server, client, call, todos, p, front, back };
}

let c: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { c = await setup(); });
afterEach(async () => { await c.client.close(); await c.server.close(); });

test('도구 목록에 todo_list, todo_add, todo_update, todo_remove 가 있다', async () => {
  const names = (await c.client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(['todo_list', 'todo_add', 'todo_update', 'todo_remove']));
});

test('todo_add 는 호출한 워크스페이스 범위에 만들고 updatedBy 는 agent', async () => {
  const made = (await c.call('todo_add', { title: 'API 설계', detail: '응답 형식', assignee: 'user' })).json();
  expect(made).toMatchObject({ title: 'API 설계', detail: '응답 형식', assignee: 'user', status: 'todo', rev: 1, scope: 'workspace' });
  expect(c.todos.get(made.id)).toMatchObject({ workspaceId: c.front.id, updatedBy: 'agent' });
  expect(c.todos.pendingCount(c.front.id)).toBe(0);
});

test('todo_list 는 자기 워크스페이스 항목과 프로젝트 범위 항목만 준다', async () => {
  c.todos.add({ projectId: c.p.id, workspaceId: c.front.id, title: 'F' }, 'agent');
  c.todos.add({ projectId: c.p.id, workspaceId: c.back.id, title: 'B' }, 'agent');
  c.todos.add({ projectId: c.p.id, workspaceId: null, title: 'P' }, 'user');
  const out = (await c.call('todo_list')).json();
  expect(out.items.map((t: { title: string; scope: string }) => [t.title, t.scope]).sort()).toEqual([['F', 'workspace'], ['P', 'project']]);
  expect(Object.keys(out.items[0]).sort()).toEqual(['assignee', 'detail', 'id', 'rev', 'scope', 'status', 'title']);
});

test('todo_list 는 사용자 변경을 userChanges 로 주고 두 번째 호출에서는 비어 있다', async () => {
  c.todos.add({ projectId: c.p.id, workspaceId: c.front.id, title: '배포' }, 'user');
  expect((await c.call('todo_list')).json().userChanges).toEqual(['추가됨: "배포"']);
  expect((await c.call('todo_list')).json().userChanges).toEqual([]);
});

test('todo_update 는 맞는 rev 면 통과한다', async () => {
  const t = c.todos.add({ projectId: c.p.id, workspaceId: c.front.id, title: 'A' }, 'agent');
  const out = await c.call('todo_update', { id: t.id, rev: 1, status: 'doing' });
  expect(out.isError).toBe(false);
  expect(out.json()).toMatchObject({ status: 'doing', rev: 2 });
});

test('todo_update 는 옛 rev 면 isError 이고 현재 값을 알려준다', async () => {
  const t = c.todos.add({ projectId: c.p.id, workspaceId: c.front.id, title: 'A' }, 'agent');
  c.todos.update(t.id, { title: 'A 수정' }, { actor: 'user' });
  const out = await c.call('todo_update', { id: t.id, rev: 1, status: 'done' });
  expect(out.isError).toBe(true);
  expect(out.text).toContain('사용자가 이 항목을 먼저 바꿨다. 현재 값: ');
  expect(out.text).toContain('"title":"A 수정"');
  expect(out.text).toContain('todo_list 로 다시 읽고 판단하라.');
  expect(c.todos.get(t.id)).toMatchObject({ title: 'A 수정', status: 'todo' });
});

test('다른 워크스페이스의 항목과 프로젝트 범위 항목은 고칠 수 없다', async () => {
  const other = c.todos.add({ projectId: c.p.id, workspaceId: c.back.id, title: 'B' }, 'agent');
  const proj = c.todos.add({ projectId: c.p.id, workspaceId: null, title: 'P' }, 'user');
  for (const t of [other, proj]) {
    const up = await c.call('todo_update', { id: t.id, rev: 1, status: 'done' });
    expect(up.isError).toBe(true);
    expect(up.text).toBe('이 워크스페이스의 항목만 고칠 수 있다.');
    const rm = await c.call('todo_remove', { id: t.id, rev: 1 });
    expect(rm.isError).toBe(true);
    expect(c.todos.get(t.id)).toMatchObject({ status: 'todo' });
  }
});

test('없는 항목은 isError', async () => {
  const out = await c.call('todo_update', { id: 'nope', rev: 1, status: 'done' });
  expect(out.isError).toBe(true);
});

test('todo_remove 는 맞는 rev 면 지운다', async () => {
  const t = c.todos.add({ projectId: c.p.id, workspaceId: c.front.id, title: 'A' }, 'agent');
  expect((await c.call('todo_remove', { id: t.id, rev: 1 })).json()).toEqual({ removed: true });
  expect(c.todos.get(t.id)).toBeUndefined();
});
