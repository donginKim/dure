import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { MAX_NOTE_BODY } from '@core/notes';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core; let ws: Workspace;
async function call(name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(ws.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}
beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  const projectId = core.projects.create('p').id;
  const repo = await core.addRepo(projectId, makeRepo('repo'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('메모를 만들고, 고치고, 지운다. 목록은 고친 순서다', async () => {
  const a = core.notes.create({ title: '배포 순서', body: '1. 태그\n2. 배포' });
  const b = core.notes.create({ body: '회의: 금요일 3시' });
  expect(core.notes.list().map((n) => n.id)).toEqual([b.id, a.id]);
  await new Promise((r) => setTimeout(r, 5));
  const changed = core.notes.update(a.id, { body: '1. 태그\n2. 배포\n3. 확인' });
  expect(changed.updatedAt).toBeGreaterThan(a.updatedAt);
  expect(core.notes.list().map((n) => n.id)).toEqual([a.id, b.id]);
  expect(core.notes.list()[0]).toMatchObject({ title: '배포 순서', preview: '1. 태그 2. 배포 3. 확인' });
  // 바뀐 것이 없으면 시각이 그대로다
  expect(core.notes.update(a.id, { body: changed.body }).updatedAt).toBe(changed.updatedAt);
  core.notes.remove(b.id);
  expect(core.notes.get(b.id)).toBeUndefined();
  expect(() => core.notes.update(b.id, { body: 'x' })).toThrow('메모가 없습니다');
  expect(() => core.notes.create({ body: 'x'.repeat(MAX_NOTE_BODY + 1) })).toThrow('너무 깁니다');
});

test('제목과 본문에서 찾는다. 낱말을 여러 개 주면 모두 든 것만, 대소문자는 가리지 않는다', () => {
  core.notes.create({ title: 'Kafka 설정', body: 'broker 주소는 설정 파일에 있다' });
  core.notes.create({ title: '점심', body: '김치찌개' });
  core.notes.create({ title: '', body: `${'가'.repeat(200)} kafka 토픽 이름 ${'나'.repeat(200)}` });
  expect(core.notes.list('kafka').length).toBe(2);
  expect(core.notes.list('KAFKA 토픽').length).toBe(1);
  // 본문에서 찾으면 찾은 곳의 앞뒤가 보인다
  expect(core.notes.list('토픽')[0]!.preview).toMatch(/^…가+ kafka 토픽 이름/);
  expect(core.notes.list('없는말')).toEqual([]);
  // % 와 _ 는 글자 그대로 찾는다
  core.notes.create({ body: '할인 50% 적용' });
  expect(core.notes.list('50%').length).toBe(1);
  expect(core.notes.list('%').length).toBe(1);
  expect(core.notes.list('_')).toEqual([]);
});

test('에이전트는 사용자가 켰을 때만 메모를 읽는다. 고치는 도구는 없다', async () => {
  const n = core.notes.create({ title: '배포 순서', body: '태그 → 배포' });
  expect(await call('note_search', { query: '배포' })).toContain('메모를 열어 두지 않았다');
  expect(await call('note_read', { id: n.id })).toContain('메모를 열어 두지 않았다');
  core.settings.update({ notesForAgents: true });
  expect(await call('note_search', { query: '배포' })).toContain(n.id);
  const read = await call('note_read', { id: n.id });
  expect(read).toContain('태그 → 배포');
  expect(read).toContain('사용자가 적어 둔 메모다');
  expect(await call('note_read', { id: 'nope' })).toContain('그런 메모가 없다');
  const tools = await (await fetch(core.mcpUrl, { method: 'POST', headers: { Authorization: `Bearer ${core.workspaces.getToken(ws.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text();
  expect(tools.match(/"name":"note_[a-z]+"/g)).toEqual(['"name":"note_search"', '"name":"note_read"']);
});
