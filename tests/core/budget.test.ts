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
  expect(core.budget.status(projectId)).toMatchObject({ state: 'ok', dailyLimit: 2_000_000, dailyFromDefault: true });
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

test('여러 프로젝트 대시보드: 진행 중인 프로젝트마다 TODO 진행, 에이전트, 오늘 토큰, 예산을 모은다', async () => {
  const other = core.projects.create('두 번째');
  const repo = await core.addRepo(other.id, makeRepo('two'));
  const w = await core.service.create({ projectId: other.id, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
  core.todos.add({ projectId: other.id, workspaceId: w.id, title: '하나', status: 'done' }, 'user');
  core.todos.add({ projectId: other.id, workspaceId: w.id, title: '둘', status: 'doing' }, 'user');
  core.todos.add({ projectId: other.id, workspaceId: w.id, title: '셋', status: 'cancelled' }, 'user');
  const d = core.dashboard().find((x) => x.projectId === other.id)!;
  expect(d.todos).toEqual({ total: 2, done: 1, doing: 1 });
  expect(d.agents).toMatchObject({ total: 1, waiting: 0 });
  expect(d.budget).toMatchObject({ today: 0, state: 'ok' });
  expect(d.share).toBeNull();
  expect(d.lastShip).toBeNull();
  // 오늘 쓴 토큰은 그 프로젝트에만, 완료된 프로젝트는 빠진다
  spend(1234);
  expect(core.dashboard().find((x) => x.projectId === projectId)!.budget.today).toBe(1234);
  core.projects.setStatus(other.id, 'done');
  expect(core.dashboard().map((x) => x.projectId)).toEqual([projectId]);
});

test('기본 하루 예산: 프로젝트에 상한이 없으면 설정의 기본값을 쓰고, 프로젝트에 정한 값이 이긴다', () => {
  core.settings.update({ defaultBudgetDaily: 10_000 });
  spend(9_000);
  expect(core.budget.status(projectId)).toMatchObject({ dailyLimit: 10_000, dailyFromDefault: true, state: 'warning' });
  core.budget.setLimits(projectId, { daily: 50_000, total: 0 });
  expect(core.budget.status(projectId)).toMatchObject({ dailyLimit: 50_000, dailyFromDefault: false, state: 'ok' });
  core.budget.setLimits(projectId, { daily: 0, total: 0 });
  core.settings.update({ defaultBudgetDaily: 0 });
  expect(core.budget.status(projectId)).toMatchObject({ dailyLimit: 0, state: 'ok' });
  expect(() => core.settings.update({ autoCompactTokens: 5_000 })).toThrow('자동 압축');
});

test('하단바: 오늘 쓴 토큰(캐시 읽기는 따로), 최근 7일, 프로젝트별, 계정의 한도 소식', () => {
  spend(4_000);
  spend(1_000, Date.now() - 2 * 86_400_000);
  const b = core.usageBar();
  expect(b.today).toMatchObject({ counted: 4_000, cacheRead: 1_000_000, requests: 1 });
  expect(b.week).toHaveLength(7);
  expect(b.week.at(-1)).toBe(4_000);
  expect(b.week.at(-3)).toBe(1_000);
  expect(b.projects).toEqual([{ projectId, name: '쇼핑몰', counted: 4_000 }]);
  expect(b.limit).toBeNull();
  core.service.noteLimit(ws.id, { status: 'warning', kind: 'five_hour', resetsAt: 1_900_000_000, utilization: 0.8 });
  expect(core.usageBar().limit).toMatchObject({ status: 'warning', kind: 'five_hour', utilization: 0.8 });
});

test('한도 창: 사용률과 초기화 시각을 기억하고, 최근 속도로 한도에 닿는 때를 어림한다 (초기화 전에 닿지 않으면 없음)', () => {
  const t0 = 1_800_000_000_000;
  const now = vi.spyOn(Date, 'now');
  const reset = Math.round((t0 + 5 * 3_600_000) / 1000);
  now.mockReturnValue(t0);
  core.service.noteLimit(ws.id, { status: 'allowed', kind: 'five_hour', resetsAt: reset, utilization: null, windows: [{ kind: 'five_hour', utilization: 0.4, resetsAt: reset, status: 'allowed' }, { kind: 'seven_day', utilization: 0.05, resetsAt: reset + 86_400 * 3, status: 'allowed' }] });
  now.mockReturnValue(t0 + 30 * 60_000);
  core.service.noteLimit(ws.id, { status: 'allowed', kind: 'five_hour', resetsAt: reset, utilization: null, windows: [{ kind: 'five_hour', utilization: 0.6, resetsAt: reset, status: 'allowed' }, { kind: 'seven_day', utilization: 0.05, resetsAt: reset + 86_400 * 3, status: 'allowed' }] });
  const w = core.usageBar().windows;
  expect(w.map((x) => x.kind)).toEqual(['five_hour', 'seven_day']);
  // 30분에 20% 올랐다: 남은 40% 는 60분 뒤
  expect(w[0]!.eta).toBe(t0 + 90 * 60_000);
  // 7일 창은 오르지 않았다
  expect(w[1]!.eta).toBeNull();
  now.mockRestore();
});
