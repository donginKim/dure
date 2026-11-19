import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

vi.setConfig({ testTimeout: 60_000 });

let core: Core; let projectId: string; let ws: Workspace;
async function call(workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}
beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: 'API', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('에이전트의 도구 호출이 감사 기록에 남는다: 도구 이름과 결과만, 읽기만 하는 도구는 적지 않는다', async () => {
  await call(ws.id, 'todo_add', { title: '비밀스러운 할 일 제목' });
  await call(ws.id, 'todo_list');
  await call(ws.id, 'project_overview');
  await call(ws.id, 'memory_save', { kind: 'lesson', text: '기억에 남길 글' });
  await call(ws.id, 'message_send', { to: '없는 워크스페이스', body: '몰래 보내는 글' });
  const rows = core.audit.list({ actor: 'agent' });
  expect(rows.map((e) => `${e.action}:${e.outcome}`).reverse()).toEqual(['tool.todo_add:ok', 'tool.memory_save:ok', 'tool.message_send:failed']);
  expect(rows[0]).toMatchObject({ actorName: 'API', projectId, workspaceId: ws.id });
  expect(rows[0]!.reason).not.toBe('');
  // 인자와 본문은 적히지 않는다
  expect(JSON.stringify(core.audit.list())).not.toMatch(/비밀스러운|기억에 남길|몰래 보내는/);
  expect(core.audit.verify()).toMatchObject({ ok: true });
});

test('두레가 스스로 한 일도 남는다: 에이전트 실행 시도와 그때의 권한·모델', async () => {
  await core.service.startAgent(ws.id, { cols: 80, rows: 24 }).catch(() => undefined); // 시험 환경에는 claude 가 없다
  const launch = core.audit.list({ action: 'agent.launch' });
  expect(launch).toHaveLength(1);
  expect(launch[0]).toMatchObject({ actor: 'system', target: 'API', detail: { agent: 'claude', permissionMode: 'auto' } });
});
