import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecrets } from '@core/autoship';
import { createCore, type Core } from '@core/index';
import type { ReviewRunner } from '@core/review';
import type { VerifyRunner } from '@core/verify';
import type { Repo, Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let repo: Repo;
let ws: Workspace;
let pass = true;
let findings: unknown[] = [];
const verifyRunner: VerifyRunner = async () => ({ code: pass ? 0 : 1, output: pass ? 'ok' : 'FAIL', timedOut: false });
const reviewRunner: ReviewRunner = async () => ({ ok: true, text: `\`\`\`json\n${JSON.stringify({ summary: 's', findings })}\n\`\`\`` });
const until = async (cond: () => boolean, ms = 8000): Promise<void> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

beforeEach(async () => {
  pass = true; findings = [];
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(), verifyRunner, reviewRunner });
  projectId = core.projects.create('쇼핑몰').id;
  repo = await core.addRepo(projectId, makeRepo('shop'));
  core.verify.setCommand(repo.id, 'pnpm test');
  ws = await core.service.create({ projectId, repoId: repo.id, name: 'API', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('findSecrets: 비밀 값처럼 보이는 파일과 글을 찾는다 (값은 담지 않는다)', () => {
  expect(findSecrets([{ path: '.env', text: '' }, { path: '.env.example', text: '' }, { path: 'a.ts', text: '+const k = "AKIAABCDEFGHIJKLMNOP";\n-old' }, { path: 'b.ts', text: '+ok' }]))
    .toEqual(['.env: 비밀 값이 들어 있을 수 있는 파일', 'a.ts: AWS 키처럼 보이는 글']);
  expect(findSecrets([{ path: 'k.txt', text: '+-----BEGIN OPENSSH PRIVATE KEY-----' }])).toEqual(['k.txt: 개인 키처럼 보이는 글']);
  expect(JSON.stringify(findSecrets([{ path: 'a.ts', text: '+ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]))).not.toContain('ghp_');
});

test('main 까지: 확인 명령·리뷰·비밀 값을 거쳐 커밋하고 main 을 앞으로 감는다', async () => {
  core.projects.setAutoShip(projectId, 'main');
  const before = gitOut(repo.path, 'rev-parse', 'main');
  writeFileSync(join(ws.worktreePath, 'api.ts'), 'export const api = 1;\n');
  core.commitDrafts.save(ws.id, 'feat: api');
  await until(() => core.autoShip.events(projectId).some((e) => e.stage === 'done' || !e.ok));
  expect(core.autoShip.events(projectId).map((e) => [e.stage, e.ok])).toEqual([['done', true], ['commit', true]]);
  const main = gitOut(repo.path, 'rev-parse', 'main');
  expect(main).not.toBe(before);
  expect(gitOut(repo.path, 'ls-tree', '--name-only', main).split('\n')).toContain('api.ts');
  expect(gitOut(repo.path, 'log', '-1', '--format=%s', `${main}^2`)).toBe('feat: api');
  expect(core.commitDrafts.get(ws.id)).toBeUndefined();
  const told = core.messages.undelivered(ws.id).map((m) => m.body).join('\n');
  expect(told).toContain('main 에 들어갔다');
  // push 는 하지 않는다 (원격이 없어도 아무 일도 없다)
  expect(core.attention.list().some((i) => i.kind === 'ship')).toBe(false);
});

test('걸리면 멈추고 확인할 것에 올린다: 확인 명령 실패, 리뷰의 높음, 비밀 값, 확인 명령이 없음', async () => {
  core.projects.setAutoShip(projectId, 'main');
  const before = gitOut(repo.path, 'rev-parse', 'main');
  const draft = async (file: string, body: string): Promise<string> => {
    writeFileSync(join(ws.worktreePath, file), body);
    core.commitDrafts.save(ws.id, `chore: ${file}`);
    const n = core.autoShip.events(projectId).length;
    await until(() => core.autoShip.events(projectId).length > n);
    return core.autoShip.events(projectId)[0]!.message;
  };
  pass = false;
  expect(await draft('a.ts', 'a\n')).toContain('확인 명령이 실패했습니다');
  pass = true;
  findings = [{ severity: '높음', file: 'a.ts', title: '경로 검사 없음', detail: '' }];
  expect(await draft('a.ts', 'b\n')).toContain('리뷰가 높음 1건을 찾았습니다: 경로 검사 없음');
  findings = [];
  expect(await draft('.env', 'TOKEN=x\n')).toContain('비밀 값이 들어 있을 수 있어 멈췄습니다: .env');
  expect(core.attention.list().find((i) => i.kind === 'ship')).toMatchObject({ workspaceId: ws.id, title: '"API" 의 자동 반영이 멈췄습니다' });
  // 아무것도 커밋되지 않았다
  expect(gitOut(ws.worktreePath, 'rev-list', '--count', 'main..HEAD')).toBe('0');
  expect(gitOut(repo.path, 'rev-parse', 'main')).toBe(before);
  // 확인 명령이 없는 저장소는 자동으로 하지 않는다
  core.verify.setCommand(repo.id, '');
  expect(await draft('c.ts', 'c\n')).toContain('확인 명령이 없어');
});

test('commit 까지만: 워크스페이스 브랜치에 커밋하고 main 은 그대로. 끄면 아무것도 하지 않는다', async () => {
  core.projects.setAutoShip(projectId, 'commit');
  const before = gitOut(repo.path, 'rev-parse', 'main');
  writeFileSync(join(ws.worktreePath, 'x.ts'), 'x\n');
  core.commitDrafts.save(ws.id, 'feat: x');
  await until(() => core.autoShip.events(projectId).length > 0);
  expect(core.autoShip.events(projectId)[0]).toMatchObject({ stage: 'commit', ok: true });
  expect(gitOut(ws.worktreePath, 'log', '-1', '--format=%s')).toBe('feat: x');
  expect(gitOut(repo.path, 'rev-parse', 'main')).toBe(before);
  core.projects.setAutoShip(projectId, 'off');
  writeFileSync(join(ws.worktreePath, 'y.ts'), 'y\n');
  core.commitDrafts.save(ws.id, 'feat: y');
  await new Promise((r) => setTimeout(r, 3600));
  expect(core.autoShip.events(projectId).length).toBe(1);
  expect(core.commitDrafts.get(ws.id)?.message).toBe('feat: y');
}, 15_000);
