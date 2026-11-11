import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitShimScript } from '@core/agents/gitShim';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

const REAL_GIT = '/usr/bin/git';
type Run = (args: string[], o?: { cwd?: string; input?: string }) => Promise<{ code: number; out: string; err: string }>;

function runner(shim: string, defaultCwd: string): Run {
  return (args, o = {}) => new Promise((resolve) => {
    const child = execFile(shim, args, { encoding: 'utf8', cwd: o.cwd ?? defaultCwd }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
    child.stdin?.end(o.input ?? '');
  });
}

// 진짜 git 과 진짜 저장소로: 워크스페이스의 작업 폴더에서만 막는지 본다.
function real() {
  const repo = makeRepo('워크스페이스 repo');
  const dir = tempDir('shim ');
  const shim = join(dir, 'git');
  writeFileSync(shim, gitShimScript(REAL_GIT, join(repo, '.git')));
  chmodSync(shim, 0o700);
  writeFileSync(join(repo, 'new.txt'), 'x\n');
  gitOut(repo, 'add', '-A');
  return { repo, run: runner(shim, repo), count: () => gitOut(repo, 'rev-list', '--count', 'HEAD') };
}

// 가짜 진짜-git: 받은 인자를 한 줄에 하나씩 찍고, 표준 입력을 그대로 내보내고, 종료 코드 7 로 끝난다.
function fake() {
  const dir = tempDir('shim fake ');
  const realGit = join(dir, 'real git');
  writeFileSync(realGit, '#!/bin/sh\nfor a in "$@"; do printf "ARG:%s|\\n" "$a"; done\ncat\nexit 7\n');
  chmodSync(realGit, 0o755);
  const shim = join(dir, 'git');
  writeFileSync(shim, gitShimScript(realGit, join(dir, 'no such repo', '.git')));
  chmodSync(shim, 0o700);
  return { run: runner(shim, dir) };
}

test.each([
  [['commit', '-m', 'a']],
  [['-c', 'user.name=x', 'commit', '-m', 'a']],
  [['--no-pager', 'commit', '-m', 'a']],
  [['-P', 'commit', '-m', 'a']],
  [['--literal-pathspecs', 'commit', '-m', 'a']],
  [['--attr-source', 'HEAD', 'commit', '-m', 'a']],
  [['-c', 'core.x=-C', 'commit', '-m', 'a']],
])('워크스페이스 작업 폴더에서 %j 는 거절되고 커밋이 생기지 않는다', async (args) => {
  const { run, count } = real();
  const r = await run(args);
  expect(r.code).toBe(1);
  expect(r.err).toContain('[두레] git commit 은 사용자가 두레 화면에서 직접 한다');
  expect(count()).toBe('1');
});

test('다른 폴더에서 -C 로 워크스페이스를 가리켜도 거절된다', async () => {
  const { repo, run, count } = real();
  const r = await run(['-C', repo, 'commit', '-m', 'a'], { cwd: tempDir() });
  expect(r.code).toBe(1);
  expect(count()).toBe('1');
});

test('하위 폴더에서 실행해도 거절된다', async () => {
  const { repo, run, count } = real();
  mkdirSync(join(repo, 'sub dir'));
  expect((await run(['commit', '-m', 'a'], { cwd: join(repo, 'sub dir') })).code).toBe(1);
  expect(count()).toBe('1');
});

test('사용자의 git 별칭으로 돌아가는 commit, push 도 거절된다', async () => {
  const { repo, run, count } = real();
  gitOut(repo, 'config', 'alias.ci', 'commit');
  gitOut(repo, 'config', 'alias.cm', 'commit -m');
  gitOut(repo, 'config', 'alias.pu', 'push');
  gitOut(repo, 'config', 'alias.shc', '!git commit -m via-shell');
  for (const args of [['ci', '-m', 'a'], ['cm', 'a'], ['shc']]) {
    const r = await run(args);
    expect(r.code).toBe(1);
    expect(r.err).toContain('[두레] git commit');
  }
  expect((await run(['pu'])).err).toContain('[두레] git push');
  expect(count()).toBe('1');
});

test('push 는 거절된다', async () => {
  const { run } = real();
  const r = await run(['push', 'origin', 'main']);
  expect(r.code).toBe(1);
  expect(r.err.trim()).toBe('[두레] git push 는 사용자가 두레 화면에서 직접 한다. 에이전트는 push 하지 않는다.');
});

test('commit 거절 안내문', async () => {
  const r = await real().run(['commit', '-m', 'x']);
  expect(r.err.trim()).toBe([
    '[두레] git commit 은 사용자가 두레 화면에서 직접 한다. 에이전트는 커밋하지 않는다.',
    '지금 할 일: 커밋 메시지를 commit_draft_save 도구로 저장하고, 사용자에게 커밋할 준비가 됐다고 알려라.',
  ].join('\n'));
});

test('워크스페이스가 아닌 다른 저장소의 커밋은 막지 않는다 (테스트가 만드는 임시 저장소 등)', async () => {
  const { run } = real();
  const other = makeRepo('다른 repo');
  writeFileSync(join(other, 'o.txt'), 'x\n');
  gitOut(other, 'add', '-A');
  const r = await run(['commit', '-q', '-m', 'in other repo'], { cwd: other });
  expect(r.code).toBe(0);
  expect(gitOut(other, 'log', '-1', '--format=%s')).toBe('in other repo');
  expect((await run(['-C', other, 'commit', '--allow-empty', '-q', '-m', 'via -C'], { cwd: tempDir() })).code).toBe(0);
});

test('워크스페이스 안에서도 commit, push 가 아닌 명령은 그대로 된다', async () => {
  const { run } = real();
  const r = await run(['status', '--short']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('new.txt');
  expect((await run(['log', '--grep', 'commit', '--oneline'])).code).toBe(0);
  expect((await run(['-C', 'commit', 'status'])).code).not.toBe(1); // "commit" 은 -C 의 값이다 (없는 폴더라 git 이 128 로 끝난다)
});

test('넘길 때 인자가 그대로다: 공백, 따옴표, 줄바꿈, $(…)', async () => {
  const marker = join(tempDir(), 'pwned');
  const args = ['log', '--grep', `a b "q" 'r' $(touch ${marker}) \`x\``, '--format', '두 번째\n줄'];
  const r = await fake().run(args);
  expect(r.out).toBe(args.map((a) => `ARG:${a}|\n`).join(''));
  expect(existsSync(marker)).toBe(false);
});

test('넘길 때 진짜 git 의 종료 코드와 표준 입력이 그대로 전해진다', async () => {
  const r = await fake().run(['hash-object', '--stdin'], { input: '입력 그대로\n' });
  expect(r.code).toBe(7);
  expect(r.out).toContain('입력 그대로\n');
});

test('인자가 없어도 그대로 넘긴다', async () => {
  expect((await fake().run([])).code).toBe(7);
});

test('진짜 git 경로와 작업 폴더 경로에 작은따옴표와 공백이 있어도 스크립트가 깨지지 않는다', async () => {
  const dir = tempDir("it's a dir ");
  const realGit = join(dir, "real 'git'");
  writeFileSync(realGit, '#!/bin/sh\necho REAL-RAN\n'); chmodSync(realGit, 0o755);
  const shim = join(dir, 'git');
  writeFileSync(shim, gitShimScript(realGit, join(realpathSync(dir), "re'po", '.git')));
  chmodSync(shim, 0o700);
  expect((await runner(shim, dir)(['status'])).out).toContain('REAL-RAN');
});
