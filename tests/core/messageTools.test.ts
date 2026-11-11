import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let dataDir: string;
let projectId: string;
let front: Workspace;
let back: Workspace;
const clients: Client[] = [];

async function connect(ws: Workspace) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(core.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${core.workspaces.getToken(ws.id)}` } } }));
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0].text;
    return { isError: res.isError === true, text, json: () => JSON.parse(text) };
  };
}

function runHook(ws: Workspace, event: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(join(dataDir, 'workspaces', ws.id, 'hook.sh'), [event], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin?.end('{}');
  });
}

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  const fakeBin = join(tempDir(), 'fake bin');
  mkdirSync(fakeBin);
  for (const n of ['claude', 'codex']) { writeFileSync(join(fakeBin, n), '#!/bin/sh\nexec cat\n'); chmodSync(join(fakeBin, n), 0o755); }
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() } });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  const mk = (name: string) => core.service.create({ projectId, repoId: repo.id, name, baseBranch: 'main', agentKind: 'claude' });
  front = await mk('프론트');
  back = await mk('백엔드');
  // 받는 쪽을 "작업 중" 으로 두어 자동으로 띄우거나 깨우지 않게 한다
  for (const w of [front, back]) { await core.service.startAgent(w.id, { cols: 80, rows: 24 }); await runHook(w, 'PreToolUse'); }
});
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); await core.dispose(); });

test('message_send 는 이름으로 받는 사람을 찾고 threadId 와 delivery 를 돌려준다', async () => {
  const call = await connect(front);
  const out = (await call('message_send', { to: '백엔드', body: 'API 형식 정해줘' })).json();
  expect(out.delivery).toBe('작업 중이라 다음 단계에 읽는다');
  const msgs = core.messages.messages(out.threadId);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ id: out.messageId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: 'API 형식 정해줘' });
  const reply = (await (await connect(back))('message_send', { to: '프론트', body: '정했다', thread_id: out.threadId })).json();
  expect(reply.threadId).toBe(out.threadId);
});

test('message_send: 없는 이름과 겹치는 이름은 isError 이고 후보 이름을 알려준다', async () => {
  const call = await connect(front);
  const none = await call('message_send', { to: '디자인', body: 'x' });
  expect(none.isError).toBe(true);
  expect(none.text).toContain('백엔드');
  const repo = core.repos.list(projectId)[0];
  await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
  const dup = await call('message_send', { to: '백엔드', body: 'x' });
  expect(dup.isError).toBe(true);
  expect(dup.text).toContain('이름이 같은 워크스페이스가 둘 이상');
});

test('message_send: 자기 자신에게는 isError', async () => {
  const out = await (await connect(front))('message_send', { to: '프론트', body: 'x' });
  expect(out.isError).toBe(true);
  expect(out.text).toContain('자기 자신에게는 보낼 수 없습니다.');
});

test('message_inbox 는 받은 메시지를 주고 두 번째 호출에서는 비어 있다', async () => {
  const a = core.messages.publish({ projectId, workspaceId: front.id, kind: 'note', title: '메모', body: '본문' });
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '읽어봐', artifactIds: [a.id] });
  const call = await connect(back);
  const first = (await call('message_inbox')).json();
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]).toMatchObject({ from: '프론트', body: '읽어봐', artifacts: [{ id: a.id, title: '메모', kind: 'note' }] });
  expect(typeof first.messages[0].threadId).toBe('string');
  expect((await call('message_inbox')).json().messages).toEqual([]);
});

test('message_inbox 로 가져간 메시지는 hook 으로 다시 전달되지 않는다', async () => {
  core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '한 번만' });
  await (await connect(back))('message_inbox');
  expect(await runHook(back, 'PostToolUse')).toBe('');
});

test('thread_read 는 자기와 무관한 스레드를 주지 않는다', async () => {
  const repo = core.repos.list(projectId)[0];
  const third = await core.service.create({ projectId, repoId: repo.id, name: '디자인', baseBranch: 'main', agentKind: 'claude' });
  const m = core.messages.send({ projectId, from: { kind: 'workspace', workspaceId: front.id }, toWorkspaceId: back.id, body: '둘만의 말' });
  const mine = (await (await connect(back))('thread_read', { thread_id: m.threadId })).json();
  expect(mine.thread).toMatchObject({ id: m.threadId, title: '둘만의 말' });
  expect(mine.messages).toEqual([expect.objectContaining({ from: '프론트', to: '백엔드', body: '둘만의 말' })]);
  const other = await (await connect(third))('thread_read', { thread_id: m.threadId });
  expect(other.isError).toBe(true);
});

test('artifact_publish → artifact_list → artifact_read', async () => {
  const call = await connect(back);
  const made = (await call('artifact_publish', { kind: 'api-spec', title: '로그인 API', body: 'POST /login → { token }' })).json();
  expect(made).toMatchObject({ kind: 'api-spec', title: '로그인 API' });
  const list = (await (await connect(front))('artifact_list')).json();
  expect(list.artifacts).toEqual([expect.objectContaining({ id: made.id, title: '로그인 API', kind: 'api-spec', by: '백엔드' })]);
  expect('body' in list.artifacts[0]).toBe(false);
  const read = (await (await connect(front))('artifact_read', { id: made.id })).json();
  expect(read).toMatchObject({ title: '로그인 API', body: 'POST /login → { token }' });
});

test('artifact_publish: 상대 경로는 isError', async () => {
  const out = await (await connect(back))('artifact_publish', { kind: 'result', title: '로그', path: 'logs/x.log' });
  expect(out.isError).toBe(true);
  expect(out.text).toContain('절대 경로');
});

test('다른 프로젝트의 자료는 읽을 수 없다', async () => {
  const other = core.projects.create('다른 프로젝트');
  const repo = await core.addRepo(other.id, makeRepo('other'));
  const ows = await core.service.create({ projectId: other.id, repoId: repo.id, name: 'x', baseBranch: 'main', agentKind: 'claude' });
  const a = core.messages.publish({ projectId: other.id, workspaceId: ows.id, kind: 'note', title: '비밀', body: 's' });
  const out = await (await connect(front))('artifact_read', { id: a.id });
  expect(out.isError).toBe(true);
});

test('message_send: 멈춘 스레드로 보내면 delivery 가 멈춤을 알린다', async () => {
  const call = await connect(front);
  const first = (await call('message_send', { to: '백엔드', body: '첫째' })).json();
  core.messages.pauseThread(first.threadId, true);
  const second = (await call('message_send', { to: '백엔드', body: '둘째', thread_id: first.threadId })).json();
  expect(second.delivery).toBe('대화가 멈춰 있어 사용자가 재개하면 전달된다');
});
