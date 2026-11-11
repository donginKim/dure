import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGit, GitError } from '@core/git';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

const git = createGit();
const write = (repo: string, name: string, body: string) => writeFileSync(join(repo, name), body);

function repoWithOrigin() {
  const repo = makeRepo('커밋 repo');
  const bare = join(tempDir(), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  gitOut(repo, 'remote', 'add', 'origin', bare);
  return { repo, bare };
}

test('changedFiles: 수정, 추가, 삭제, 추적 안 됨을 구분하고 줄 수를 준다', async () => {
  const repo = makeRepo();
  write(repo, 'keep.txt', 'a\nb\n'); write(repo, 'gone.txt', 'x\n');
  gitOut(repo, 'add', '-A'); gitOut(repo, 'commit', '-q', '-m', 'base');
  write(repo, 'keep.txt', 'a\nB\nc\n');
  rmSync(join(repo, 'gone.txt'));
  write(repo, 'staged.txt', 'new\n'); gitOut(repo, 'add', 'staged.txt');
  write(repo, 'loose.txt', 'u\n');
  const files = await git.changedFiles(repo);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(by['keep.txt']).toMatchObject({ status: 'modified', added: 2, removed: 1 });
  expect(by['gone.txt']).toMatchObject({ status: 'deleted', removed: 1 });
  expect(by['staged.txt']).toMatchObject({ status: 'added', added: 1 });
  expect(by['loose.txt']).toMatchObject({ status: 'untracked', added: null, removed: null });
  expect(files).toHaveLength(4);
});

test('changedFiles: 이름 바뀜은 renamed 이고 from 에 옛 경로', async () => {
  const repo = makeRepo();
  write(repo, 'old name.txt', 'same content\nline2\nline3\n');
  gitOut(repo, 'add', '-A'); gitOut(repo, 'commit', '-q', '-m', 'base');
  gitOut(repo, 'mv', 'old name.txt', '새 이름.txt');
  const files = await git.changedFiles(repo);
  expect(files).toEqual([expect.objectContaining({ path: '새 이름.txt', status: 'renamed', from: 'old name.txt' })]);
});

test('changedFiles: 공백·한글·따옴표가 든 파일 이름이 그대로 나온다', async () => {
  const repo = makeRepo();
  write(repo, '새 문서 "초안".md', 'x\n');
  mkdirSync(join(repo, '하위 폴더'));
  write(repo, '하위 폴더/a b.txt', 'y\n');
  expect((await git.changedFiles(repo)).map((f) => f.path).sort()).toEqual(['새 문서 "초안".md', '하위 폴더/a b.txt'].sort());
});

test('changedFiles: 바뀐 것이 없으면 빈 목록', async () => {
  expect(await git.changedFiles(makeRepo())).toEqual([]);
});

test('commitFiles: 고른 파일만 커밋되고 나머지는 바뀐 채로 남는다', async () => {
  const repo = makeRepo();
  write(repo, 'a.txt', '1\n'); write(repo, 'b.txt', '2\n');
  const res = await git.commitFiles({ path: repo, files: ['a.txt'], message: 'add a' });
  expect(res.subject).toBe('add a');
  expect(res.hash).toMatch(/^[0-9a-f]{7,}$/);
  expect(gitOut(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
  expect((await git.changedFiles(repo)).map((f) => f.path)).toEqual(['b.txt']);
});

test('commitFiles: 메시지의 따옴표, 줄바꿈, $(…), - 로 시작하는 줄이 글자 그대로 커밋 메시지가 된다', async () => {
  const repo = makeRepo();
  const marker = join(tempDir(), 'dure-x');
  write(repo, 'a.txt', '1\n');
  const message = `-m 처럼 보이는 제목\n\n--amend\n$(touch ${marker}) "따옴표" \`backtick\``;
  await git.commitFiles({ path: repo, files: ['a.txt'], message });
  expect(gitOut(repo, 'log', '-1', '--format=%B')).toBe(message);
  expect(existsSync(marker)).toBe(false);
  expect(gitOut(repo, 'rev-list', '--count', 'HEAD')).toBe('2'); // --amend 로 읽히지 않았다
});

test('commitFiles: - 로 시작하는 파일 이름도 옵션으로 읽히지 않는다', async () => {
  const repo = makeRepo();
  write(repo, '-rf.txt', 'x\n');
  await git.commitFiles({ path: repo, files: ['-rf.txt'], message: 'odd name' });
  expect(gitOut(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('-rf.txt');
});

test('commitFiles: 삭제한 파일과 이름 바꾼 파일을 커밋할 수 있다', async () => {
  const repo = makeRepo();
  write(repo, 'gone.txt', 'x\n'); write(repo, 'old.txt', 'keep this content\nsecond\nthird\n');
  gitOut(repo, 'add', '-A'); gitOut(repo, 'commit', '-q', '-m', 'base');
  rmSync(join(repo, 'gone.txt'));
  renameSync(join(repo, 'old.txt'), join(repo, 'new.txt'));
  const files = await git.changedFiles(repo);
  await git.commitFiles({ path: repo, files: files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])), message: 'rm and mv' });
  expect(await git.changedFiles(repo)).toEqual([]);
  expect(gitOut(repo, 'ls-files').split('\n').sort()).toEqual(['README.md', 'new.txt']);
});

test('commitFiles: 빈 파일 목록과 빈 메시지는 오류', async () => {
  const repo = makeRepo();
  write(repo, 'a.txt', '1\n');
  await expect(git.commitFiles({ path: repo, files: [], message: 'x' })).rejects.toThrow('커밋할 파일을 고르세요.');
  await expect(git.commitFiles({ path: repo, files: ['a.txt'], message: '  \n ' })).rejects.toThrow('커밋 메시지를 입력하세요.');
});

test('commitFiles: pre-commit hook 이 거절하면 GitError 이고 hook 의 출력이 stderr 에 있다', async () => {
  const repo = makeRepo();
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "린트 실패: 고치고 다시 하세요" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  write(repo, 'a.txt', '1\n');
  const err = await git.commitFiles({ path: repo, files: ['a.txt'], message: 'x' }).catch((e) => e);
  expect(err).toBeInstanceOf(GitError);
  expect((err as GitError).stderr).toContain('린트 실패: 고치고 다시 하세요');
  expect(gitOut(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
});

test('remoteUrl: origin 이 없으면 null, 있으면 주소', async () => {
  expect(await git.remoteUrl(makeRepo())).toBeNull();
  const { repo, bare } = repoWithOrigin();
  expect(await git.remoteUrl(repo)).toBe(bare);
});

test('push: bare 원격으로 보내고 aheadCount 가 0 이 된다', async () => {
  const { repo, bare } = repoWithOrigin();
  expect(await git.aheadCount(repo, 'main')).toBeNull(); // 원격 브랜치가 아직 없다
  await git.push({ path: repo, branch: 'main' });
  expect(await git.aheadCount(repo, 'main')).toBe(0);
  expect(execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(gitOut(repo, 'rev-parse', 'HEAD'));
  write(repo, 'a.txt', '1\n');
  await git.commitFiles({ path: repo, files: ['a.txt'], message: 'next' });
  expect(await git.aheadCount(repo, 'main')).toBe(1);
});

test('push: 원격이 앞서 있으면 GitError 이고 강제로 밀지 않는다', async () => {
  const { repo, bare } = repoWithOrigin();
  await git.push({ path: repo, branch: 'main' });
  // 다른 곳에서 원격에 커밋을 올린다
  const other = join(tempDir(), 'other');
  execFileSync('git', ['clone', '-q', bare, other]);
  writeFileSync(join(other, 'theirs.txt'), 't\n');
  execFileSync('git', ['-C', other, 'add', '-A']);
  execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'theirs']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
  const remoteHead = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  write(repo, 'mine.txt', 'm\n');
  await git.commitFiles({ path: repo, files: ['mine.txt'], message: 'mine' });
  await expect(git.push({ path: repo, branch: 'main' })).rejects.toBeInstanceOf(GitError);
  expect(execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(remoteHead);
});
