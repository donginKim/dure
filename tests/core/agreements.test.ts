import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let a: Workspace;
let b: Workspace;
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
  a = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
  b = await core.service.create({ projectId, repoId: repo.id, name: 'API', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('에이전트는 제안만 한다. 사용자가 받아들이면 약속이 되고 모든 에이전트에게 알린다', async () => {
  expect(await call(b.id, 'agreement_propose', { kind: 'api', title: 'POST /login', body: '요청: {"email": string}\n응답: {"token": string}' })).toContain('사용자의 확인을 기다린다');
  // 아직 약속이 아니다
  const before = await call(a.id, 'agreements_list');
  expect(before).toContain('\\"agreements\\":[]');
  expect(before).toContain('아직 약속이 아니다');
  expect(core.attention.list().find((i) => i.kind === 'agreement')).toMatchObject({ title: 'API 이(가) 약속을 제안했습니다', detail: 'POST /login' });
  const p = core.agreements.list(projectId, { proposed: true })[0]!;
  core.agreements.accept(p.id);
  expect(await call(a.id, 'agreements_list')).toContain('POST /login');
  for (const w of [a, b]) expect(core.messages.undelivered(w.id).map((m) => m.body).join('\n')).toContain('[두레] 프로젝트에 약속이 생겼다: "POST /login"');
  expect(core.attention.list().some((i) => i.kind === 'agreement')).toBe(false);
  // 바꾸자는 제안: 받아들이면 앞의 약속이 바뀌고, 바뀌었다고 알린다
  expect(await call(a.id, 'agreement_propose', { kind: 'api', title: 'POST /login (v2)', body: '응답에 refresh 추가', replaces: p.id })).toContain('기다린다');
  const change = core.agreements.list(projectId, { proposed: true }).find((x) => x.status === 'proposed')!;
  core.agreements.accept(change.id);
  const now = core.agreements.list(projectId);
  expect(now.map((x) => [x.id, x.title])).toEqual([[p.id, 'POST /login (v2)']]);
  expect(core.messages.undelivered(b.id).map((m) => m.body).join('\n')).toContain('약속이 바뀌었다: "POST /login (v2)"');
  // 없는 약속을 바꾸자고 할 수 없다
  expect(await call(a.id, 'agreement_propose', { kind: 'api', title: 'x', body: 'y', replaces: 'nope' })).toContain('바꾸려는 약속이 없다');
});

test('사용자가 바로 적고 고치고 지운다. 빈 제목·내용은 받지 않는다', () => {
  const x = core.agreements.save(projectId, { kind: 'naming', title: '테이블 이름은 snake_case', body: '예: order_items' });
  expect(x).toMatchObject({ status: 'active', author: '사용자' });
  expect(core.agreements.save(projectId, { id: x.id, kind: 'naming', title: '테이블 이름', body: 'snake_case, 복수형' }).body).toBe('snake_case, 복수형');
  expect(core.messages.undelivered(a.id).map((m) => m.body).join('\n')).toContain('약속이 바뀌었다: "테이블 이름"');
  expect(() => core.agreements.save(projectId, { title: ' ', body: 'x' })).toThrow('제목');
  expect(() => core.agreements.save(projectId, { title: 'x', body: '' })).toThrow('내용');
  core.agreements.remove(x.id);
  expect(core.agreements.list(projectId)).toEqual([]);
});
