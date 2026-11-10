import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, branchExists, currentBranch, GitError, isGitRepo, listBranches, removeWorktree } from '@core/git';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

test('isGitRepo: 저장소는 true, 일반 폴더와 없는 경로는 false', async () => {
  const repo = makeRepo();
  expect(await isGitRepo(repo)).toBe(true);
  expect(await isGitRepo(tempDir())).toBe(false);
  expect(await isGitRepo('/nonexistent/두레')).toBe(false);
});

test('addWorktree 는 공백·한글 경로에 새 브랜치로 worktree 를 만든다', async () => {
  const repo = makeRepo();
  const worktreePath = join(tempDir(), '두레 wt', '프론트 화면');
  await addWorktree({ repoPath: repo, worktreePath, branch: 'dure/프론트-화면', baseBranch: 'main' });
  expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
  expect(await currentBranch(worktreePath)).toBe('dure/프론트-화면');
  expect(await branchExists(repo, 'dure/프론트-화면')).toBe(true);
  expect(await branchExists(repo, 'dure/없음')).toBe(false);
});

test('없는 기준 브랜치면 GitError 이고 stderr 가 채워진다', async () => {
  const repo = makeRepo();
  const worktreePath = join(tempDir(), 'wt');
  const err = await addWorktree({ repoPath: repo, worktreePath, branch: 'dure/x', baseBranch: 'no-such-branch' }).catch((e) => e);
  expect(err).toBeInstanceOf(GitError);
  expect((err as GitError).stderr.length).toBeGreaterThan(0);
});

test('removeWorktree 뒤 폴더가 없고 git worktree list 에서 빠진다', async () => {
  const repo = makeRepo();
  const worktreePath = join(tempDir(), '지울 wt');
  await addWorktree({ repoPath: repo, worktreePath, branch: 'dure/del', baseBranch: 'main' });
  mkdirSync(join(worktreePath, 'untracked dir')); // 추적 안 된 파일이 있어도 지워져야 한다
  await removeWorktree({ repoPath: repo, worktreePath });
  expect(existsSync(worktreePath)).toBe(false);
  expect(gitOut(repo, 'worktree', 'list')).not.toContain('지울 wt');
});

test('사용자가 폴더를 직접 지운 worktree 도 removeWorktree 로 정리된다', async () => {
  const repo = makeRepo();
  const worktreePath = join(tempDir(), 'gone');
  await addWorktree({ repoPath: repo, worktreePath, branch: 'dure/gone', baseBranch: 'main' });
  (await import('node:fs')).rmSync(worktreePath, { recursive: true, force: true });
  await removeWorktree({ repoPath: repo, worktreePath });
  expect(gitOut(repo, 'worktree', 'list')).not.toContain('gone');
});

test('listBranches 는 로컬 브랜치 이름을 돌려준다', async () => {
  const repo = makeRepo();
  gitOut(repo, 'branch', 'develop');
  expect((await listBranches(repo)).sort()).toEqual(['develop', 'main']);
  expect(await currentBranch(repo)).toBe('main');
});

test('git 을 실행할 수 없으면 isGitRepo 는 false 가 아니라 GitError 를 던진다', async () => {
  const { createGit } = await import('@core/git');
  const repo = makeRepo();
  const broken = createGit({ PATH: '/nonexistent' });
  await expect(broken.isGitRepo(repo)).rejects.toBeInstanceOf(GitError);
  await expect(broken.isGitRepo(repo)).rejects.toThrow('git 을 실행할 수 없습니다');
});

test('createGit 에 준 환경으로 git 이 실행된다', async () => {
  const { createGit } = await import('@core/git');
  const repo = makeRepo();
  const git = createGit({ PATH: '/usr/bin:/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'dure.test', GIT_CONFIG_VALUE_0: 'yes' });
  expect(await git.isGitRepo(repo)).toBe(true);
  expect(await git.raw(['-C', repo, 'config', 'dure.test'])).toBe('yes\n');
});

test('uncommittedCount 는 커밋하지 않은 변경 수를 센다', async () => {
  const { uncommittedCount } = await import('@core/git');
  const fs = await import('node:fs');
  const repo = makeRepo();
  expect(await uncommittedCount(repo)).toBe(0);
  fs.writeFileSync(join(repo, 'new.txt'), 'x');
  fs.writeFileSync(join(repo, 'README.md'), 'changed');
  expect(await uncommittedCount(repo)).toBe(2);
});

test('deleteBranch 는 브랜치를 지운다', async () => {
  const { deleteBranch } = await import('@core/git');
  const repo = makeRepo();
  gitOut(repo, 'branch', 'tmp');
  await deleteBranch(repo, 'tmp');
  expect(await branchExists(repo, 'tmp')).toBe(false);
});
