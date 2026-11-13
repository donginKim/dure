import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import { mergeOrder } from '@core/merge';
import type { VerifyRunner } from '@core/verify';
import type { Repo, Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let repo: Repo;
let ran: string[] = [];
let pass = true;
const runner: VerifyRunner = async (o) => { ran.push(o.cwd); return { code: pass ? 0 : 1, output: pass ? 'ok' : 'FAIL test', timedOut: false }; };
const commitIn = (dir: string, file: string, body: string, msg: string): void => {
  writeFileSync(join(dir, file), body);
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', msg], { stdio: 'pipe' });
};
const make = async (name: string): Promise<Workspace> => core.service.create({ projectId, repoId: repo.id, name, baseBranch: 'main', agentKind: 'claude' });

beforeEach(async () => {
  ran = []; pass = true;
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(), verifyRunner: runner });
  projectId = core.projects.create('쇼핑몰').id;
  repo = await core.addRepo(projectId, makeRepo('shop'));
});
afterEach(async () => { await core.dispose(); });

test('mergeOrder: 다른 워크스페이스의 일을 기다리면 그 워크스페이스를 먼저, 아니면 만든 순서', () => {
  const ws = [{ id: 'ui', createdAt: 1 }, { id: 'api', createdAt: 2 }, { id: 'docs', createdAt: 3 }];
  const todos = [{ id: 't1', workspaceId: 'api', after: [] }, { id: 't2', workspaceId: 'ui', after: ['t1'] }, { id: 't3', workspaceId: 'docs', after: [] }];
  expect(mergeOrder(ws, todos)).toEqual(['api', 'ui', 'docs']);
  // 돌고 돌면 기다릴 것 없는 것이 먼저, 나머지는 만든 순서
  expect(mergeOrder(ws, [{ id: 'a', workspaceId: 'ui', after: ['b'] }, { id: 'b', workspaceId: 'api', after: ['a'] }])).toEqual(['docs', 'ui', 'api']);
});

test('미리 보기: 차례로 합쳐 보고 충돌과 함께 충돌하는 브랜치를 찾는다. 아무것도 바꾸지 않는다', async () => {
  const api = await make('API');
  const ui = await make('화면');
  const docs = await make('문서');
  commitIn(api.worktreePath, 'shared.ts', 'export const v = "api";\n', 'api');
  commitIn(ui.worktreePath, 'shared.ts', 'export const v = "ui";\n', 'ui');
  commitIn(docs.worktreePath, 'docs.md', '# 문서\n', 'docs');
  writeFileSync(join(docs.worktreePath, 'draft.md'), '커밋 안 함');
  const mainBefore = gitOut(repo.path, 'rev-parse', 'main');
  const [p] = await core.merges.plans(projectId);
  expect(p!.steps.map((s) => [s.name, s.state, s.ahead])).toEqual([['API', 'ok', 1], ['화면', 'conflict', 1], ['문서', 'ok', 1]]);
  const conflict = p!.steps[1]!;
  expect(conflict.conflicts).toEqual(['shared.ts']);
  expect(conflict.with).toEqual([api.id]);
  expect(p!.steps[2]!.uncommitted).toBe(1);
  expect(p!.result).toBeTruthy();
  expect(p!.ready).toBe(false);
  // 아무것도 바꾸지 않았다
  expect(gitOut(repo.path, 'rev-parse', 'main')).toBe(mainBefore);
  expect(gitOut(repo.path, 'branch', '--list', 'dure/merge-*')).toBe('');
  // 충돌한 에이전트에게: 함께 충돌하는 브랜치를 합쳐 풀라고
  await core.merges.askToResolve(projectId, repo.id, 'main', ui.id);
  const told = core.messages.undelivered(ui.id).map((m) => m.body).join('\n');
  expect(told).toContain(`git merge ${api.branch}`);
  expect(told).toContain('충돌하는 파일: shared.ts');
  await expect(core.merges.askToResolve(projectId, repo.id, 'main', api.id)).rejects.toThrow('충돌한 워크스페이스가 아닙니다');
});

test('합치기 브랜치를 만들고 확인 명령을 돌린다. 사용자가 누르면 기준 브랜치를 앞으로 감는다', async () => {
  core.verify.setCommand(repo.id, 'pnpm test');
  const api = await make('API');
  const ui = await make('화면');
  commitIn(api.worktreePath, 'api.ts', 'export const api = 1;\n', 'api');
  commitIn(ui.worktreePath, 'ui.ts', 'export const ui = 1;\n', 'ui');
  // 확인 명령이 실패하면 알린다 (합치기 브랜치는 만들어진다)
  pass = false;
  const bad = await core.merges.prepare(projectId, repo.id, 'main');
  expect(bad.verify).toEqual({ ok: false, output: 'FAIL test' });
  expect(ran.length).toBe(1);
  pass = true;
  const r = await core.merges.prepare(projectId, repo.id, 'main');
  expect(r.verify).toEqual({ ok: true, output: 'ok' });
  expect(r.plan.ready).toBe(true);
  const merged = gitOut(repo.path, 'rev-parse', 'dure/merge-main');
  expect(gitOut(repo.path, 'ls-tree', '--name-only', merged).split('\n').sort()).toEqual(['README.md', 'api.ts', 'ui.ts']);
  // 임시 작업 폴더는 지워졌다
  expect(gitOut(repo.path, 'worktree', 'list')).not.toContain('.merge');
  // main 은 아직 그대로
  expect(gitOut(repo.path, 'rev-parse', 'main')).not.toBe(merged);
  // 저장소 폴더에 커밋 안 한 변경이 있으면 옮기지 않는다
  writeFileSync(join(repo.path, 'local.txt'), 'x');
  await expect(core.merges.advance(projectId, repo.id, 'main')).rejects.toThrow('커밋하지 않은 변경');
  execFileSync('rm', [join(repo.path, 'local.txt')]);
  expect(await core.merges.advance(projectId, repo.id, 'main')).toContain('main 를');
  expect(gitOut(repo.path, 'rev-parse', 'main')).toBe(merged);
  // 이제 다 들어갔다
  const [after] = await core.merges.plans(projectId);
  expect(after!.steps.map((s) => s.state)).toEqual(['merged', 'merged']);
  expect(after!.result).toBeNull();
});

test('기준 브랜치가 그사이 바뀌면 옮기지 않는다', async () => {
  const api = await make('API');
  commitIn(api.worktreePath, 'api.ts', 'x\n', 'api');
  await core.merges.prepare(projectId, repo.id, 'main');
  commitIn(repo.path, 'other.txt', 'y\n', '사용자가 main 에 직접 커밋');
  await expect(core.merges.advance(projectId, repo.id, 'main')).rejects.toThrow('앞으로 감기로 옮길 수 없습니다');
});
