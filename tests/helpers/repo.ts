import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 공백과 한글이 든 임시 폴더. macOS 의 /var → /private/var 를 풀어서 돌려준다. */
export function tempDir(prefix = '두레 테스트 '): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 커밋이 하나 있는 실제 git 저장소를 만든다. 폴더 이름에 공백과 한글이 있다. */
export function makeRepo(name = '두레 테스트 repo'): string {
  const dir = join(tempDir(), name);
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'dure-test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export function gitOut(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}
