import { join } from 'node:path';
import { usageOf } from '@core/chat/transcript';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';

const row = (id: string, o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string => JSON.stringify({
  type: 'assistant', uuid: `u-${Math.random()}`, timestamp: '2026-11-12T10:00:00.000Z',
  message: { id, model: 'claude-x', usage: { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, ...o } }, ...extra,
});

test('기록 한 줄에서 사용량을 읽는다. 모델이 답한 줄에만 있다', () => {
  expect(usageOf(row('msg_1'))).toEqual({ messageId: 'msg_1', model: 'claude-x', input: 2, output: 100, cacheWrite: 1000, cacheRead: 5000, at: Date.parse('2026-11-12T10:00:00.000Z') });
  // 보조 에이전트의 답도 센다
  expect(usageOf(row('msg_2', {}, { isSidechain: true }))?.messageId).toBe('msg_2');
  expect(usageOf(JSON.stringify({ type: 'user', message: { content: 'x' } }))).toBeNull();
  expect(usageOf('{"type":"assistant","message":{"usage":{"input_tokens":1}}}')).toBeNull();
  expect(usageOf('not json "usage"')).toBeNull();
  expect(usageOf(row('msg_3', { input_tokens: -5, output_tokens: 'x' }))).toMatchObject({ input: 0, output: 0 });
});

describe('사용량 모으기', () => {
  let core: Core; let a: Workspace; let b: Workspace; let projectId: string;
  beforeEach(async () => {
    core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
    projectId = core.projects.create('p').id;
    const repo = await core.addRepo(projectId, makeRepo('repo'));
    a = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
    b = await core.service.create({ projectId, repoId: repo.id, name: '서버', baseBranch: 'main', agentKind: 'claude' });
  });
  afterEach(async () => { await core.dispose(); });
  const u = (id: string, at: number, o: Partial<{ input: number; output: number; cacheWrite: number; cacheRead: number }> = {}) => ({ messageId: id, model: 'claude-x', input: 10, output: 100, cacheWrite: 0, cacheRead: 1000, at, ...o });

  test('같은 답은 한 번만 세고, 워크스페이스마다 모은다. 많이 쓴 것이 위다', () => {
    const now = Date.now();
    core.usage.record(a.id, u('m1', now));
    core.usage.record(a.id, u('m1', now, { output: 150 }));   // 같은 답이 다시 적혔다: 나중 값으로
    core.usage.record(b.id, u('m2', now, { output: 5000 }));
    core.usage.record(b.id, u('m3', now));
    const s = core.usage.summary(projectId);
    expect(s.total).toEqual({ input: 30, output: 5250, cacheWrite: 0, cacheRead: 3000, requests: 3 });
    expect(s.workspaces.map((w) => [w.name, w.requests, w.output])).toEqual([['서버', 2, 5100], ['화면', 1, 150]]);
    expect(s.models).toMatchObject([{ model: 'claude-x', requests: 3 }]);
  });

  test('기간으로 거른다. 워크스페이스를 지워도 쓴 기록은 남는다', async () => {
    const now = Date.now();
    core.usage.record(a.id, u('old', now - 10 * 86_400_000));
    core.usage.record(a.id, u('new', now));
    expect(core.usage.summary(projectId).total.requests).toBe(2);
    expect(core.usage.summary(projectId, now - 86_400_000).total.requests).toBe(1);
    await core.service.discard(a.id);
    const s = core.usage.summary(projectId);
    expect(s.workspaces).toMatchObject([{ name: '화면', gone: true, requests: 2 }]);
    // 없는 워크스페이스의 것은 적지 않는다
    core.usage.record('nope', u('x', now));
    expect(core.usage.summary(projectId).total.requests).toBe(2);
  });
});
