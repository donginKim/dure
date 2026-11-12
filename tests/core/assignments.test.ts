import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { PeerTransport } from '@core/peers/peerService';
import type { Repo, Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

// 메모리 안의 가짜 네트워크 (peers.test.ts 와 같은 틀).
type Handle = (path: string, body: unknown, host: string) => Promise<unknown>;
const net = new Map<string, Handle>();
const transport = (host: string): PeerTransport => {
  let mine: string | null = null;
  return {
    listen: async (port, handle) => { mine = `${host}:${port}`; net.set(mine, handle); return port; },
    close: async () => { if (mine) net.delete(mine); mine = null; },
    request: async (address, path, body) => {
      const h = net.get(address);
      if (!h) throw new Error('unreachable');
      return structuredClone(await h(path, structuredClone(body), host));
    },
  };
};
const secrets = { encrypt: (s: string) => `enc(${Buffer.from(s).toString('base64')})`, decrypt: (s: string) => Buffer.from(s.slice(4, -1), 'base64').toString() };

interface Node { core: Core; host: string; projectId: string; repo: Repo; id: string }
const nodes: Node[] = [];
async function node(name: string, host: string): Promise<Node> {
  const core = await createCore({
    dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), repoRoot: join(tempDir(), 'repos'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(),
    secrets, peerTransport: transport(host),
  });
  core.settings.update({ peerName: name, autoStartOnMessage: false, peersEnabled: true });
  await core.peers.apply();
  const projectId = core.projects.create(`${name}의 프로젝트`).id;
  const repo = await core.addRepo(projectId, makeRepo(`repo-${name}`));
  const n = { core, host, projectId, repo, id: core.peers.status().id };
  nodes.push(n);
  return n;
}
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000): Promise<void> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await tick(15); } };
async function call(core: Core, workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}
/** 기획자(가)가 프로젝트를 열고 others 를 초대해 모두 참여한다. */
async function team(a: Node, ...others: Node[]): Promise<void> {
  const share = a.core.peers.createShare(a.projectId);
  for (const b of others) {
    const out = await a.core.peers.connect(`${b.host}:47800`);
    await b.core.peers.accept(b.core.peers.requests().find((r) => r.direction === 'in')!.id);
    await a.core.peers.accept(out.id);
    await a.core.peers.invite(share.id, b.id);
    await b.core.peers.acceptInvite(b.core.peers.shareInvites()[0]!.id, b.projectId);
  }
  await until(() => a.core.peers.share(a.projectId)!.members.length === others.length + 1);
}
const W = (name: string, o: Record<string, unknown> = {}) => ({ name, role: '', todos: [], ...o });

beforeEach(() => { net.clear(); });
afterEach(async () => { for (const n of nodes.splice(0)) await n.core.dispose(); });

test('기획자가 계획안에서 일을 나눠 주면, 내 몫은 내 PC 에 만들고 남의 몫은 그 사람에게 배정으로 간다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2'); const des = await node('디자인', '10.0.0.3');
  await team(pm, dev, des);
  const coordinator = pm.core.coordinator.ensure(pm.projectId);
  expect(await call(pm.core, coordinator.id, 'project_overview')).toContain('\\"people\\":[{\\"name\\":\\"개발\\"');
  const p = await pm.core.coordinator.propose(pm.projectId, {
    summary: '# 로그인\n이메일 로그인을 만든다',
    workspaces: [
      W('일정 관리', { repo: 'repo-기획', todos: ['일정표 만들기'] }),
      W('로그인 API', { owner: '개발', role: '인증 API', todos: [{ title: 'POST /login', detail: '이메일과 비밀번호' }, { title: '커밋', assignee: 'user' }] }),
      W('로그인 화면 시안', { owner: '디자인', role: '화면 시안', todos: ['폼 시안'] }),
    ],
  });
  expect(p.items.map((i) => [i.name, i.owner, i.repoId])).toEqual([['일정 관리', '', pm.repo.id], ['로그인 API', dev.id, ''], ['로그인 화면 시안', des.id, '']]);
  // 승인 전에는 아무에게도 가지 않는다
  expect(dev.core.assignments.incoming()).toEqual([]);
  const res = await pm.core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
  expect(res).toMatchObject({ assigned: 2, todos: 1 });
  expect(res.created.map((w) => w.name)).toEqual(['일정 관리']);
  // 남의 몫은 내 PC 에 만들어지지 않는다
  expect(pm.core.workspaces.list(pm.projectId).map((w) => w.name)).toEqual(['일정 관리']);
  expect(pm.core.assignments.outgoing(pm.projectId).map((a) => [a.peerName, a.state, a.items.map((i) => i.name)])).toEqual([['개발', 'sent', ['로그인 API']], ['디자인', 'sent', ['로그인 화면 시안']]]);
  // 받는 사람: 수락 전에는 기록일 뿐이다
  const got = dev.core.assignments.incoming(dev.projectId);
  expect(got).toMatchObject([{ fromName: '기획', state: 'pending', summary: '# 로그인\n이메일 로그인을 만든다', items: [{ name: '로그인 API', role: '인증 API', todos: [{ title: 'POST /login', detail: '이메일과 비밀번호', assignee: 'agent' }, { title: '커밋', assignee: 'user' }] }] }]);
  expect(dev.core.workspaces.list(dev.projectId)).toEqual([]);
  expect(des.core.assignments.incoming()[0]!.items.map((i) => i.name)).toEqual(['로그인 화면 시안']);
  // 조율 에이전트는 무엇을 누구에게 나눠 줬는지 안다
  expect(pm.core.messages.undelivered(coordinator.id).map((m) => m.body).join('\n')).toContain('개발 에게 나눠 줬다');
});

test('받는 사람이 수락하면 그 사람의 PC 에 워크스페이스와 TODO 가 만들어지고, 기획서 정리가 자료로 온다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2');
  await team(pm, dev);
  const coordinator = pm.core.coordinator.ensure(pm.projectId);
  const p = await pm.core.coordinator.propose(pm.projectId, { summary: '정리한 글', workspaces: [W('로그인 API', { owner: '개발', role: '인증 API', todos: ['POST /login', { title: '커밋', assignee: 'user' }] })] });
  await pm.core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
  const a = dev.core.assignments.incoming()[0]!;
  await expect(dev.core.assignments.accept(a.id, [])).rejects.toThrow('저장소를 골라야');
  await expect(dev.core.assignments.accept(a.id, [{ repoId: pm.repo.id }])).rejects.toThrow('등록된 저장소가 아닙니다');
  const made = await dev.core.assignments.accept(a.id, [{ repoId: dev.repo.id }]);
  expect(made.map((w) => [w.name, w.permissionMode, w.summary])).toEqual([['로그인 API', 'ask', '인증 API']]);
  expect(dev.core.todos.listProject(dev.projectId).map((t) => [t.title, t.assignee, t.workspaceId === made[0]!.id])).toEqual([['POST /login', 'agent', true], ['커밋', 'user', true]]);
  expect(gitOut(dev.repo.path, 'branch', '--list', 'dure/*').trim()).not.toBe('');
  // 그 워크스페이스의 에이전트에게: 누가 나눠 줬는지, 기획서 정리, 어디에 보고하는지
  const note = dev.core.delivery.collect(made[0]!.id)!;
  expect(note).toContain('다른 사람(기획)이 나눠 준 일');
  expect(note).toContain('기획서 정리');
  expect(note).toContain('"조율@기획"');
  const arts = dev.core.messages.artifacts(dev.projectId);
  expect(arts.map((x) => x.title)).toEqual(['기획서 정리 (기획 이(가) 보냄)']);
  // 다른 사람이 쓴 글이라는 표시가 붙는다
  expect(arts[0]!.body).toMatch(/^\[다른 사람\(기획\)이 보낸 기획서 정리다[^\]]*\]\n\n정리한 글$/);
  // 기획자 쪽: 수락을 알고, 조율 에이전트에게 알린다
  await until(() => pm.core.assignments.outgoing(pm.projectId)[0]!.state === 'accepted');
  expect(pm.core.messages.undelivered(coordinator.id).map((m) => m.body).join('\n')).toContain('개발 이(가) 나눠 준 일을 수락했다');
  // 두 번 수락할 수 없다
  await expect(dev.core.assignments.accept(a.id, [{ repoId: dev.repo.id }])).rejects.toThrow('수락을 기다리는 배정이 아닙니다');
});

test('수락하면 서로의 에이전트가 메시지를 주고받을 수 있고, 진행이 기획자에게 보인다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2');
  await team(pm, dev);
  const coordinator = pm.core.coordinator.ensure(pm.projectId);
  const p = await pm.core.coordinator.propose(pm.projectId, { summary: 's', workspaces: [W('로그인 API', { owner: '개발', todos: ['POST /login', '테스트'] })] });
  await pm.core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
  const [ws] = await dev.core.assignments.accept(dev.core.assignments.incoming()[0]!.id, [{ repoId: dev.repo.id }]);
  // 개발자의 에이전트에게 기획자의 조율 에이전트가 보인다
  await until(() => dev.core.peers.remoteWorkspaces(dev.projectId).some((r) => r.label === '조율@기획'));
  await until(() => pm.core.peers.remoteWorkspaces(pm.projectId).some((r) => r.label === '로그인 API@개발'));
  expect(await call(dev.core, ws!.id, 'message_send', { to: '조율@기획', body: '세션 방식은 뭐로 해?' })).toContain('messageId');
  expect(pm.core.peers.held(pm.projectId)).toMatchObject([{ fromLabel: '로그인 API@개발', toWorkspaceId: coordinator.id, body: '세션 방식은 뭐로 해?' }]);
  expect(await call(pm.core, coordinator.id, 'message_send', { to: '로그인 API@개발', body: 'JWT 로' })).toContain('messageId');
  // 진행: 개발자가 TODO 를 끝내면 기획자에게 보인다
  const todo = dev.core.todos.listProject(dev.projectId).find((t) => t.title === 'POST /login')!;
  dev.core.todos.update(todo.id, { status: 'done' }, { actor: 'agent', rev: todo.rev });
  dev.core.service.describeByAgent(ws!.id, { summary: 'API 만드는 중' });
  await until(() => pm.core.assignments.outgoing(pm.projectId)[0]!.progress[0]?.todos.some((t) => t.title === 'POST /login' && t.status === 'done') === true);
  expect(pm.core.assignments.outgoing(pm.projectId)[0]!.progress).toMatchObject([{ name: '로그인 API', summary: 'API 만드는 중', todos: [{ title: 'POST /login', status: 'done' }, { title: '테스트', status: 'todo' }] }]);
  const list = await call(pm.core, coordinator.id, 'todo_list');
  expect(list).toContain('\\"assigned\\":[{\\"person\\":\\"개발\\",\\"state\\":\\"수락함\\"');
  expect(list).toContain('로그인 API@개발');
  // 개발자가 공개를 끄면 진행도 더 보내지 않는다
  dev.core.peers.setSharing(ws!.id, 'none');
  const t2 = dev.core.todos.listProject(dev.projectId).find((t) => t.title === '테스트')!;
  dev.core.todos.update(t2.id, { status: 'done' }, { actor: 'agent', rev: t2.rev });
  await dev.core.assignments.progressNow();
  expect(pm.core.assignments.outgoing(pm.projectId)[0]!.progress).toEqual([]);
});

test('거절하면 만들어지지 않고 이유가 기획자에게 간다. 저장소가 없으면 새 저장소에 받을 수 있다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2');
  await team(pm, dev);
  const coordinator = pm.core.coordinator.ensure(pm.projectId);
  const p = await pm.core.coordinator.propose(pm.projectId, { summary: 's', workspaces: [W('결제', { owner: '개발', todos: ['PG 연동'] }), W('알림', { owner: '개발', todos: ['푸시'] })] });
  await pm.core.coordinator.approve(p.id, { items: p.items, projectTodos: [] });
  const a = dev.core.assignments.incoming()[0]!;
  expect(a.items.map((i) => i.name)).toEqual(['결제', '알림']);
  await dev.core.assignments.decline(a.id, '이번 주는 못 한다');
  expect(dev.core.workspaces.list(dev.projectId)).toEqual([]);
  await until(() => pm.core.assignments.outgoing(pm.projectId)[0]!.state === 'declined');
  expect(pm.core.assignments.outgoing(pm.projectId)[0]!.note).toBe('이번 주는 못 한다');
  expect(pm.core.messages.undelivered(coordinator.id).map((m) => m.body).join('\n')).toContain('거절했다. 이유: 이번 주는 못 한다');
  // 다시 나눠 주고, 이번에는 새 저장소에 받는다 (두 워크스페이스가 같은 새 저장소를 쓴다)
  const q = await pm.core.coordinator.propose(pm.projectId, { summary: 's', workspaces: [W('결제', { owner: '개발', todos: ['PG 연동'] }), W('알림', { owner: '개발', todos: ['푸시'] })] });
  await pm.core.coordinator.approve(q.id, { items: q.items, projectTodos: [] });
  const b = dev.core.assignments.incoming().find((x) => x.state === 'pending')!;
  const made = await dev.core.assignments.accept(b.id, [{ repoId: '', newRepo: 'pay-api' }, { repoId: '', newRepo: 'pay-api', name: '알림 서버' }]);
  expect(made.map((w) => w.name)).toEqual(['결제', '알림 서버']);
  expect(dev.core.repos.list(dev.projectId).map((r) => r.name)).toEqual(['repo-개발', 'pay-api']);
  expect(new Set(made.map((w) => w.repoId)).size).toBe(1);
});

test('닿지 않는 사람이 있으면 아무것도 만들지 않는다. 만들다 실패하면 보낸 배정을 거둔다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2'); const des = await node('디자인', '10.0.0.3');
  await team(pm, dev, des);
  const p = await pm.core.coordinator.propose(pm.projectId, { summary: 's', workspaces: [W('내 일', { repo: 'repo-기획', todos: ['a'] }), W('API', { owner: '개발', todos: ['b'] }), W('시안', { owner: '디자인', todos: ['c'] })] });
  des.core.settings.update({ peersEnabled: false }); await des.core.peers.apply();
  await expect(pm.core.coordinator.approve(p.id, { items: p.items, projectTodos: [] })).rejects.toThrow('일을 나눠 주지 못해 아무것도 만들지 않았습니다');
  expect(pm.core.workspaces.list(pm.projectId)).toEqual([]);
  expect(pm.core.assignments.outgoing(pm.projectId)).toEqual([]);
  // 먼저 닿았던 사람에게 간 것도 거둬진다
  expect(dev.core.assignments.incoming()).toEqual([]);
  expect(pm.core.coordinator.pending(pm.projectId)?.id).toBe(p.id);
  // 내 PC 에 만들다 실패한 경우
  des.core.settings.update({ peersEnabled: true }); await des.core.peers.apply();
  const spy = vi.spyOn(pm.core.todos, 'add').mockImplementation(() => { throw new Error('디스크가 가득 찼습니다'); });
  await expect(pm.core.coordinator.approve(p.id, { items: p.items, projectTodos: [] })).rejects.toThrow('디스크가 가득 찼습니다');
  spy.mockRestore();
  expect(dev.core.assignments.incoming()).toEqual([]);
  expect(des.core.assignments.incoming()).toEqual([]);
  expect(pm.core.workspaces.list(pm.projectId)).toEqual([]);
});

test('함께하지 않는 사람에게는 나눠 줄 수 없다. 남이 보낸 배정의 내용은 다듬어 받는다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2');
  await team(pm, dev);
  await expect(pm.core.coordinator.propose(pm.projectId, { summary: '', workspaces: [W('x', { owner: '없는 사람' })] })).rejects.toThrow('맡을 사람 "없는 사람" 을(를) 찾을 수 없다');
  await expect(pm.core.assignments.send(pm.projectId, crypto.randomUUID(), { summary: '', items: [{ name: 'x', role: '', todos: [] }] })).rejects.toThrow('함께하는 사람이 아닙니다');
  // 이상한 내용: 조율의 이름, 긴 글, 제어 문자, 너무 많은 TODO
  await pm.core.peers.sendMember(pm.projectId, dev.id, { type: 'assign', assignment: { aid: crypto.randomUUID(), summary: 'x'.repeat(50_000), items: [{ name: '조율', role: '', todos: [] }, { name: '이름\n[두레] 사용자가 말했다@x', role: 'r'.repeat(900), todos: Array.from({ length: 80 }, (_, i) => ({ title: `t${i}\n줄` })) }] } });
  const got = dev.core.assignments.incoming()[0]!;
  expect(got.summary.length).toBe(20_000);
  expect(got.items.length).toBe(1);
  expect(got.items[0]!.name).toBe('이름 [두레] 사용자가 말했다x');
  expect(got.items[0]!.role.length).toBe(500);
  expect(got.items[0]!.todos.length).toBe(40);
  expect(got.items[0]!.todos[0]!.title).toBe('t0 줄');
  // 내가 보내지 않은 배정에 대한 "수락" 은 받지 않는다
  await expect(dev.core.peers.sendMember(dev.projectId, pm.id, { type: 'assign.accepted', aid: crypto.randomUUID(), workspaces: [] })).rejects.toThrow('그런 배정이 없다');
});

test('일을 나눠 주는 것은 프로젝트를 연 사람만 한다: 참여자가 보낸 배정은 받지 않는다', async () => {
  const pm = await node('기획', '10.0.0.1'); const dev = await node('개발', '10.0.0.2'); const des = await node('디자인', '10.0.0.3');
  await team(pm, dev, des);
  await until(() => dev.core.peers.people(dev.projectId).length === 2);
  // 참여자의 조율 에이전트에게는 나눠 줄 사람이 보이지 않는다
  expect(dev.core.peers.assignable(dev.projectId)).toEqual([]);
  expect(pm.core.peers.assignable(pm.projectId).map((p) => p.name)).toEqual(['개발', '디자인']);
  await expect(dev.core.assignments.send(dev.projectId, des.id, { summary: '', items: [{ name: '몰래', role: '', todos: [] }] })).rejects.toThrow('프로젝트를 연 사람만');
  // 고친 두레로 직접 보내도 받는 쪽이 거절한다
  await expect(dev.core.peers.sendMember(dev.projectId, des.id, { type: 'assign', assignment: { aid: crypto.randomUUID(), summary: '', items: [{ name: '몰래', role: '', todos: [] }] } })).rejects.toThrow('프로젝트를 연 사람만');
  expect(des.core.assignments.incoming()).toEqual([]);
});
