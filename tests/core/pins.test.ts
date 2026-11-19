import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { MAX_PINS, MAX_PIN_BODY } from '@core/pins';
import type { PinInput, Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core; let ws: Workspace;
const input = (itemId: string, body = '본문'): PinInput => ({ workspaceId: ws.id, itemId, kind: 'assistant', source: '에이전트', body });
beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  const projectId = core.projects.create('p').id;
  const repo = await core.addRepo(projectId, makeRepo('repo'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('꽂고, 목록은 새 것부터, 뺀다', async () => {
  let changed = 0;
  core.pins.on('changed', () => { changed++; });
  const a = core.pins.add(input('a', '첫째 글'));
  await new Promise((r) => setTimeout(r, 5));
  const b = core.pins.add(input('b', '둘째 글'));
  expect(core.pins.list(ws.id).map((p) => p.id)).toEqual([b.id, a.id]);
  expect(a).toMatchObject({ workspaceId: ws.id, itemId: 'a', kind: 'assistant', source: '에이전트', title: '첫째 글', body: '첫째 글' });
  core.pins.remove(a.id);
  expect(core.pins.list(ws.id).map((p) => p.id)).toEqual([b.id]);
  expect(changed).toBe(3);
});

test('같은 글은 한 번만 꽂힌다', () => {
  const a = core.pins.add(input('a', '처음'));
  const again = core.pins.add(input('a', '다시'));
  expect(again.id).toBe(a.id);
  expect(core.pins.list(ws.id)).toHaveLength(1);
  expect(core.pins.list(ws.id)[0]!.body).toBe('처음');
});

test('제목은 첫 줄 60자, 본문은 50,000자에서 자른다', () => {
  const p = core.pins.add(input('a', `\n\n  ${'ㄱ'.repeat(70)}\n둘째`));
  expect(p.title).toBe('ㄱ'.repeat(60));
  const long = core.pins.add(input('b', 'a'.repeat(60_000)));
  expect(long.body).toHaveLength(MAX_PIN_BODY);
  expect(MAX_PIN_BODY).toBe(50_000);
});

test('제목에서 마크다운 기호는 뗀다. 기호뿐인 줄은 건너뛴다', () => {
  expect(core.pins.add(input('a', '## 배포 순서\n1. 빌드')).title).toBe('배포 순서');
  expect(core.pins.add(input('b', '---\n- **API** 는 `4310`')).title).toBe('API 는 4310');
  expect(core.pins.add(input('c', '> 인용한 글')).title).toBe('인용한 글');
  expect(core.pins.add(input('d', '1. 첫째 할 일')).title).toBe('첫째 할 일');
  expect(core.pins.add(input('e', 'a - b * c')).title).toBe('a - b * c');
});

test('누가 쓴 글인지는 한 줄 80자로 다듬는다', () => {
  const p = core.pins.add({ ...input('a'), source: `조율@민지가\n보냄${'x'.repeat(100)}` });
  expect(p.source).not.toContain('\n');
  expect(p.source.length).toBeLessThanOrEqual(80);
});

test('200개를 넘으면 꽂지 못한다', () => {
  expect(MAX_PINS).toBe(200);
  for (let i = 0; i < MAX_PINS; i++) core.pins.add(input(`i${i}`));
  expect(() => core.pins.add(input('more'))).toThrow(/200개/);
  // 이미 꽂힌 글은 상한에 걸리지 않고 그대로 돌려준다
  expect(core.pins.add(input('i0')).itemId).toBe('i0');
});

test('없는 워크스페이스, 빈 본문, 빈 id, 모르는 kind 는 던진다', () => {
  expect(() => core.pins.add({ ...input('a'), workspaceId: 'nope' })).toThrow();
  expect(() => core.pins.add(input('a', '  \n '))).toThrow();
  expect(() => core.pins.add(input(''))).toThrow();
  expect(() => core.pins.add({ ...input('a'), kind: 'steps' as never })).toThrow();
  expect(core.pins.list(ws.id)).toHaveLength(0);
});

test('다른 워크스페이스의 핀은 섞이지 않는다', async () => {
  const repo = core.repos.list(ws.projectId)[0]!;
  const other = await core.service.create({ projectId: ws.projectId, repoId: repo.id, name: '서버', baseBranch: 'main', agentKind: 'claude' });
  core.pins.add(input('a'));
  core.pins.add({ ...input('a'), workspaceId: other.id });
  expect(core.pins.list(ws.id)).toHaveLength(1);
  expect(core.pins.list(other.id)).toHaveLength(1);
});

test('워크스페이스를 지우면 그 핀도 지워진다', async () => {
  core.pins.add(input('a'));
  await core.service.remove(ws.id, { deleteWorktree: true });
  expect(core.pins.list(ws.id)).toHaveLength(0);
});
