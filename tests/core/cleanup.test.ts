import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

const SIZE = { cols: 100, rows: 30 };
let core: Core;
let dataDir: string;
let fakeBin: string;
let projectId: string;
let repoPath: string;
let ws: Workspace;

const until = (cond: () => boolean, ms = 5000): Promise<void> => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = (): void => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : void setTimeout(tick, 20));
  tick();
});
const inWs = (p: string): string => join(ws.worktreePath, p);
const write = (p: string, body = 'x'): void => { mkdirSync(join(inWs(p), '..'), { recursive: true }); writeFileSync(inWs(p), body); };
const stored = (): string[] => {
  const dir = join(dataDir, 'cleanup', projectId);
  return existsSync(dir) ? readdirSync(dir) : [];
};

beforeEach(async () => {
  dataDir = join(tempDir(), 'dure data');
  fakeBin = join(tempDir(), 'bin');
  mkdirSync(fakeBin);
  // 살아 있기만 하는 가짜 에이전트 (터미널 방식)
  writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\nexec sleep 1000\n');
  chmodSync(join(fakeBin, 'claude'), 0o755);
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  projectId = core.projects.create('쇼핑몰').id;
  repoPath = makeRepo('front');
  writeFileSync(join(repoPath, '.gitignore'), 'dist/\n*.cache\n');
  gitOut(repoPath, 'add', '-A');
  gitOut(repoPath, 'commit', '-q', '-m', 'ignore');
  const repo = await core.addRepo(projectId, repoPath);
  ws = await core.service.create({ projectId, repoId: repo.id, name: '프론트', baseBranch: 'main', agentKind: 'claude', engine: 'terminal' });
});
afterEach(async () => { await core.dispose(); });

describe('정리 대기로 옮기기', () => {
  test('추적하지 않는 파일과 폴더를 저장소 밖으로 옮기고, 목록에 무엇을 왜 옮겼는지 남는다', async () => {
    write('debug.log', 'log line\n');
    write('scratch/try1.js', 'console.log(1)');
    write('scratch/deep/note.md', '# 메모');
    const r = await core.cleanup.stash(ws.id, ['debug.log', 'scratch'], '실험하며 만든 것\n둘째 줄');
    expect(r.skipped).toEqual([]);
    expect(r.moved.map((i) => [i.path, i.isDir])).toEqual([['debug.log', false], ['scratch', true]]);
    expect(existsSync(inWs('debug.log'))).toBe(false);
    expect(existsSync(inWs('scratch'))).toBe(false);
    const items = core.cleanup.list(projectId);
    expect(items).toMatchObject([
      { path: 'debug.log', workspaceId: ws.id, workspaceName: '프론트', reason: '실험하며 만든 것 둘째 줄', size: 9, isDir: false },
      { path: 'scratch', isDir: true },
    ]);
    expect(items[1]!.size).toBe('console.log(1)'.length + Buffer.byteLength('# 메모'));
    expect(stored().length).toBe(2);
    // 저장소에는 흔적이 없다
    expect(gitOut(ws.worktreePath, 'status', '--porcelain')).toBe('');
  });

  test('git 이 추적하는 파일, 고친 파일, 무시하는 파일은 옮기지 않고 이유를 알려 준다', async () => {
    write('README.md', '# 고침');
    write('src/new.ts', 'export {}');
    gitOut(ws.worktreePath, 'add', 'src/new.ts'); // 올려 둔 새 파일도 추적하는 것이다
    write('dist/app.js', 'built');
    write('x.cache', 'c');
    const r = await core.cleanup.stash(ws.id, ['README.md', 'src/new.ts', 'src', 'dist', 'x.cache', 'nope.txt', ''], '정리');
    expect(r.moved).toEqual([]);
    expect(r.skipped.map((s) => s.path)).toEqual(['README.md', 'src/new.ts', 'src', 'dist', 'x.cache', 'nope.txt', '']);
    expect(r.skipped[0]!.reason).toContain('추적');
    expect(r.skipped[2]!.reason).toContain('추적'); // 폴더 안에 추적하는 파일이 하나라도 있으면
    expect(r.skipped[3]!.reason).toContain('무시');
    expect(r.skipped[5]!.reason).toContain('없는 파일');
    expect(readFileSync(inWs('README.md'), 'utf8')).toBe('# 고침');
    expect(existsSync(inWs('dist/app.js'))).toBe(true);
    expect(core.cleanup.list(projectId)).toEqual([]);
  });

  test('작업 폴더 밖, 작업 폴더 자체, .git 은 옮기지 않는다', async () => {
    const outside = join(tempDir(), 'secret.txt');
    writeFileSync(outside, 's');
    write('tmp.txt');
    symlinkSync(tempDir(), inWs('link-out'));
    const r = await core.cleanup.stash(ws.id, [outside, '../..', '.', ws.worktreePath, '.git', '.git/config', 'link-out/x', '../front/tmp.txt'], '정리');
    expect(r.moved).toEqual([]);
    expect(r.skipped.length).toBe(8);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(inWs('.git'))).toBe(true);
    expect(existsSync(inWs('tmp.txt'))).toBe(true);
  });

  test('링크는 가리키는 곳을 건드리지 않고 링크만 옮긴다', async () => {
    const target = join(tempDir(), 'target dir');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    symlinkSync(target, inWs('my-link'));
    const r = await core.cleanup.stash(ws.id, ['my-link'], '임시 링크');
    expect(r.moved.map((i) => i.path)).toEqual(['my-link']);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  test('같은 것을 두 번 주거나 이미 옮긴 폴더 안의 것을 주면 한 번만 옮긴다', async () => {
    write('scratch/a.txt');
    const r = await core.cleanup.stash(ws.id, ['scratch', 'scratch', 'scratch/a.txt'], '정리');
    expect(r.moved.length).toBe(1);
  });

  test('없는 워크스페이스는 오류', async () => {
    await expect(core.cleanup.stash('없는-id', ['a'], 'x')).rejects.toThrow('워크스페이스가 없습니다');
  });
});

describe('되돌리기', () => {
  test('옮긴 것을 원래 자리에 그대로 돌려놓고 목록에서 뺀다', async () => {
    write('scratch/deep/note.md', '# 메모');
    const { moved } = await core.cleanup.stash(ws.id, ['scratch'], '정리');
    core.cleanup.restore(moved[0]!.id);
    expect(readFileSync(inWs('scratch/deep/note.md'), 'utf8')).toBe('# 메모');
    expect(core.cleanup.list(projectId)).toEqual([]);
    expect(stored()).toEqual([]);
  });

  test('그 자리에 이미 다른 것이 있으면 덮어쓰지 않고 오류를 낸다. 옮겨 둔 것은 그대로다', async () => {
    write('debug.log', '옛것');
    const { moved } = await core.cleanup.stash(ws.id, ['debug.log'], '정리');
    write('debug.log', '새것');
    expect(() => core.cleanup.restore(moved[0]!.id)).toThrow('그 자리에 이미 다른 것이 있습니다: debug.log');
    expect(readFileSync(inWs('debug.log'), 'utf8')).toBe('새것');
    expect(core.cleanup.list(projectId).length).toBe(1);
  });

  test('워크스페이스가 지워졌으면 되돌릴 수 없다고 알린다. 항목은 남는다', async () => {
    write('debug.log');
    const { moved } = await core.cleanup.stash(ws.id, ['debug.log'], '정리');
    await core.service.remove(ws.id, { deleteWorktree: true });
    expect(core.cleanup.list(projectId)).toMatchObject([{ workspaceId: null, workspaceName: '프론트', path: 'debug.log' }]);
    expect(() => core.cleanup.restore(moved[0]!.id)).toThrow('되돌릴 작업 폴더가 없습니다');
    expect(() => core.cleanup.restore('없는-id')).toThrow('정리 대기에 없는 항목입니다.');
  });
});

describe('프로젝트 완료 처리', () => {
  test('계획: 워크스페이스마다 커밋하지 않은 변경, push 하지 않은 커밋, 에이전트가 켜져 있는지와 정리 대기에 있는 것을 보여 준다', async () => {
    write('debug.log');
    await core.cleanup.stash(ws.id, ['debug.log'], '정리');
    write('new.ts', 'export {}');
    await core.service.startAgent(ws.id, SIZE);
    const plan = await core.completionPlan(projectId);
    expect(plan.workspaces).toMatchObject([{ id: ws.id, name: '프론트', exists: true, uncommitted: 1, unpushed: null, agentRunning: true }]);
    expect(plan.items.map((i) => i.path)).toEqual(['debug.log']);
    await expect(core.completionPlan('없는-id')).rejects.toThrow('프로젝트가 없습니다');
  });

  test('고른 작업 폴더와 정리 대기 항목만 지우고, 에이전트를 끄고, 프로젝트를 완료로 옮긴다. 기록과 브랜치는 남는다', async () => {
    write('a.log'); write('b.log');
    const { moved } = await core.cleanup.stash(ws.id, ['a.log', 'b.log'], '정리');
    core.todos.add({ projectId, workspaceId: ws.id, title: '로그인 화면' }, 'user');
    await core.service.startAgent(ws.id, SIZE);
    const done = await core.completeProject(projectId, { removeWorktrees: [ws.id], removeItems: [moved[0]!.id] });
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeGreaterThan(Date.now() - 5000);
    expect(existsSync(ws.worktreePath)).toBe(false);
    expect(core.service.isAgentRunning(ws.id)).toBe(false);
    expect(core.workspaces.get(ws.id)?.status).toBe('stopped');
    // 고르지 않은 정리 대기 항목은 남는다
    expect(core.cleanup.list(projectId).map((i) => i.path)).toEqual(['b.log']);
    expect(stored().length).toBe(1);
    // 기록과 브랜치는 남는다
    expect(core.todos.listProject(projectId).length).toBe(1);
    expect(core.workspaces.list(projectId).length).toBe(1);
    expect(gitOut(repoPath, 'branch', '--list', ws.branch)).toContain(ws.branch);
  });

  test('아무것도 고르지 않으면 지우지 않고 완료로만 옮긴다', async () => {
    write('a.log');
    await core.cleanup.stash(ws.id, ['a.log'], '정리');
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [] });
    expect(core.projects.get(projectId)?.status).toBe('done');
    expect(existsSync(ws.worktreePath)).toBe(true);
    expect(core.cleanup.list(projectId).length).toBe(1);
  });

  test('다른 프로젝트의 워크스페이스나 항목 id 를 주어도 그쪽은 건드리지 않는다', async () => {
    const other = core.projects.create('다른 프로젝트');
    const otherRepo = await core.addRepo(other.id, makeRepo('other'));
    const ows = await core.service.create({ projectId: other.id, repoId: otherRepo.id, name: '남의 것', baseBranch: 'main', agentKind: 'claude', engine: 'terminal' });
    writeFileSync(join(ows.worktreePath, 'o.log'), 'x');
    const o = await core.cleanup.stash(ows.id, ['o.log'], '정리');
    await core.completeProject(projectId, { removeWorktrees: [ows.id], removeItems: [o.moved[0]!.id] });
    expect(existsSync(ows.worktreePath)).toBe(true);
    expect(core.cleanup.list(other.id).length).toBe(1);
    expect(core.projects.get(other.id)?.status).toBe('active');
  });

  test('완료된 프로젝트에서는 워크스페이스를 만들거나 에이전트를 시작할 수 없다. 다시 열면 된다', async () => {
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [] });
    const repo = core.repos.list(projectId)[0]!;
    await expect(core.service.create({ projectId, repoId: repo.id, name: '새것', baseBranch: 'main', agentKind: 'claude' })).rejects.toThrow('완료된 프로젝트입니다');
    await expect(core.service.startAgent(ws.id, SIZE)).rejects.toThrow('완료된 프로젝트입니다');
    expect(core.reopenProject(projectId)).toMatchObject({ status: 'active', completedAt: null });
    await core.service.startAgent(ws.id, SIZE);
    await until(() => core.service.isAgentRunning(ws.id));
  });

  test('이미 완료된 프로젝트를 다시 완료 처리해도 아무것도 지우지 않는다', async () => {
    await core.completeProject(projectId, { removeWorktrees: [], removeItems: [] });
    await core.completeProject(projectId, { removeWorktrees: [ws.id], removeItems: [] });
    expect(existsSync(ws.worktreePath)).toBe(true);
  });

  test('프로젝트를 완전히 지우면 정리 대기에 옮겨 둔 파일도 지워진다. 작업 폴더는 남는다', async () => {
    write('a.log');
    await core.cleanup.stash(ws.id, ['a.log'], '정리');
    await core.removeProject(projectId);
    expect(core.projects.get(projectId)).toBeUndefined();
    expect(existsSync(join(dataDir, 'cleanup', projectId))).toBe(false);
    expect(existsSync(ws.worktreePath)).toBe(true);
  });
});

test('다시 켜도 프로젝트의 완료 상태와 정리 대기 목록이 남는다', async () => {
  write('a.log');
  await core.cleanup.stash(ws.id, ['a.log'], '정리');
  await core.completeProject(projectId, { removeWorktrees: [], removeItems: [] });
  await core.dispose();
  core = await createCore({ dataDir, worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: `${fakeBin}:/usr/bin:/bin`, SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  expect(core.projects.get(projectId)).toMatchObject({ status: 'done' });
  expect(core.cleanup.list(projectId).map((i) => i.path)).toEqual(['a.log']);
});
