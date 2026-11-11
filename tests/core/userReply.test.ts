import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { USER_RECIPIENT } from '@shared/messages';
import type { Workspace } from '@shared/types';
import { workspaceName } from '../../src/renderer/conversationView';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let ws: Workspace;
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
  core.settings.update({ autoStartOnMessage: false });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('사용자가 대화에 남긴 말에 에이전트가 답하면 같은 스레드에 사용자에게 보낸 메시지로 남는다', async () => {
  const asked = core.messages.send({ projectId, from: { kind: 'user' }, toWorkspaceId: ws.id, body: 'API 주소가 뭐야?' });
  const delivered = core.delivery.collect(ws.id)!;
  expect(delivered).toContain(`to "사용자", thread_id "${asked.threadId}"`);
  const text = await call(ws.id, 'message_send', { to: '사용자', body: '/todos 입니다', thread_id: asked.threadId });
  expect(text).toContain('사용자의 대화 패널에 표시됐다');
  const all = core.messages.messages(asked.threadId);
  expect(all.map((m) => [m.from.kind, m.toWorkspaceId, m.body])).toEqual([['user', ws.id, 'API 주소가 뭐야?'], ['workspace', USER_RECIPIENT, '/todos 입니다']]);
  // 전달할 것이 없으므로 바로 전달된 것으로 두고, 에이전트끼리의 왕복으로 세지 않는다
  expect(all[1]!.deliveredAt).not.toBeNull();
  expect(all[1]!.failed).toBe(false);
  expect(core.messages.thread(asked.threadId)!.agentStreak).toBe(0);
  expect(core.messages.flow(projectId)).toMatchObject({ agentStreak: 0, capped: false });
  expect(workspaceName(USER_RECIPIENT, [ws])).toBe('나');
  expect(await call(ws.id, 'thread_read', { thread_id: asked.threadId })).toContain('\\"to\\":\\"사용자\\"');
});

test('사용자에게는 워크스페이스만 보낼 수 있고, "사용자" 라는 이름의 워크스페이스는 만들 수 없다', async () => {
  expect(() => core.messages.send({ projectId, from: { kind: 'system' }, toWorkspaceId: USER_RECIPIENT, body: 'x' })).toThrow('워크스페이스만');
  const repo = core.repos.list(projectId)[0]!;
  await expect(core.service.create({ projectId, repoId: repo.id, name: '사용자', baseBranch: 'main', agentKind: 'claude' })).rejects.toThrow('사용자를 가리키는 이름');
  expect(() => core.service.rename(ws.id, '사용자')).toThrow('사용자를 가리키는 이름');
  // 스레드 없이도 보낼 수 있다 (새 스레드가 생긴다)
  expect(await call(ws.id, 'message_send', { to: '사용자', body: '끝났습니다' })).toContain('threadId');
  expect(core.messages.threads(projectId).length).toBe(1);
});
