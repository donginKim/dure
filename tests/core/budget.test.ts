import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { ReviewRunner } from '@core/review';
import type { Workspace } from '@shared/types';
import { makeRepo, tempDir } from '../helpers/repo';
import { writeFileSync } from 'node:fs';

let core: Core;
let projectId: string;
let ws: Workspace;
const reviewRunner: ReviewRunner = async () => ({ ok: true, text: '```json\n{"summary":"s","findings":[]}\n```', usage: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 99_999, model: 'claude-x' } });
const spend = (n: number, at = Date.now()): void => core.usage.record(ws.id, { messageId: crypto.randomUUID(), model: 'm', input: n, output: 0, cacheWrite: 0, cacheRead: 1_000_000, at });

beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(), reviewRunner });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: 'API', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('하루·전체 상한: 캐시에서 읽은 것은 빼고 세고, 80% 면 알리고, 넘으면 새로 일을 시키지 못한다', async () => {
  expect(core.budget.status(projectId)).toMatchObject({ state: 'ok', dailyLimit: 0 });
  core.budget.setLimits(projectId, { daily: 10_000, total: 0 });
  spend(8_500, Date.now() - 2 * 86_400_000); // 어제 이전 것은 하루 상한에 들지 않는다
  spend(8_000);
  core.budget.check(projectId);
  expect(core.budget.status(projectId)).toMatchObject({ today: 8_000, total: 16_500, state: 'warning' });
  expect(core.attention.list().find((i) => i.kind === 'budget')!.title).toBe('예산의 80% 를 넘었습니다');
  spend(2_500);
  core.budget.check(projectId);
  expect(core.budget.status(projectId).state).toBe('over');
  expect(core.budget.blocked(projectId)).toContain('오늘의 상한');
  await expect(core.service.startAgent(ws.id, { cols: 80, rows: 24 })).rejects.toThrow('예산');
  await expect(core.service.sendUserInput(ws.id, '계속')).rejects.toThrow('예산');
  await expect(core.review.review(ws.id, { force: true })).rejects.toThrow('예산');
  expect(core.attention.list().find((i) => i.kind === 'budget')!.title).toBe('예산을 넘어 에이전트를 멈췄습니다');
  // 오늘만 더 쓰기
  core.budget.allowToday(projectId);
  expect(core.budget.status(projectId)).toMatchObject({ state: 'warning' });
  expect(core.budget.status(projectId).overrideUntil).toBeGreaterThan(Date.now());
  expect(core.budget.blocked(projectId)).toBeNull();
  // 상한을 올리면 풀린다
  core.budget.setLimits(projectId, { daily: 0, total: 20_000 });
  expect(core.budget.status(projectId)).toMatchObject({ totalLimit: 20_000 });
});

test('막 넘으면 일하던 에이전트를 멈춘다. 리뷰 에이전트의 사용량도 센다', async () => {
  const stopped: string[] = [];
  core.service.interrupt = (id: string) => { stopped.push(id); };
  core.workspaces.update(ws.id, { status: 'working' });
  core.budget.setLimits(projectId, { daily: 1_000, total: 0 });
  spend(1_200);
  core.budget.check(projectId);
  expect(stopped).toEqual([ws.id]);
  // 리뷰어의 사용량
  core.budget.setLimits(projectId, { daily: 0, total: 0 });
  writeFileSync(join(ws.worktreePath, 'a.ts'), 'x\n');
  await core.review.review(ws.id, { force: true });
  const sum = core.usage.summary(projectId);
  expect(sum.total.output).toBe(500);
  expect(sum.models.map((m) => m.model)).toContain('claude-x');
});
