import { execFile } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitShimScript } from '@core/agents/gitShim';
import { tempDir } from '../helpers/repo';

// 가짜 진짜-git: 받은 인자를 한 줄에 하나씩(끝에 | 를 붙여) 찍고, 표준 입력을 그대로 내보내고, 종료 코드 7 로 끝난다.
function setup() {
  const dir = tempDir('shim test ');
  const real = join(dir, 'real git');
  writeFileSync(real, '#!/bin/sh\nfor a in "$@"; do printf "ARG:%s|\\n" "$a"; done\ncat\nexit 7\n');
  chmodSync(real, 0o755);
  const shim = join(dir, 'git');
  writeFileSync(shim, gitShimScript(real));
  chmodSync(shim, 0o700);
  const run = (args: string[], input = '') => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile(shim, args, { encoding: 'utf8' }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
    child.stdin?.end(input);
  });
  return { run };
}

test.each([
  [['commit', '-m', 'a'], 'deny'],
  [['-C', '/x y', 'commit'], 'deny'],
  [['-c', 'user.name=x', 'commit'], 'deny'],
  [['--no-pager', 'commit'], 'deny'],
  [['--git-dir=/x', 'push'], 'deny'],
  [['--git-dir', '/x', 'push', 'origin'], 'deny'],
  [['-C', '/a', '-c', 'k=v', '--no-pager', 'push', '--force'], 'deny'],
  [['status'], 'pass'],
  [['log', '--grep', 'commit'], 'pass'],
  [['-C', 'commit', 'status'], 'pass'],
  [['add', 'commit'], 'pass'],
  [['--exec-path=/x', 'diff'], 'pass'],
  [['--version'], 'pass'],
  [[] as string[], 'pass'],
])('%j → %s', async (args, expected) => {
  const { run } = setup();
  const r = await run(args);
  if (expected === 'deny') {
    expect(r.code).toBe(1);
    expect(r.out).toBe(''); // 진짜 git 은 실행되지 않았다
    expect(r.err).toContain('[두레] git ');
  } else {
    expect(r.code).toBe(7); // 진짜 git 의 종료 코드
    expect(r.out.split('\n').filter((l) => l.startsWith('ARG:')).length).toBeGreaterThanOrEqual(args.length ? 1 : 0);
  }
});

test('commit 거절 안내문', async () => {
  const r = await setup().run(['commit', '-m', 'x']);
  expect(r.err.trim()).toBe([
    '[두레] git commit 은 사용자가 두레 화면에서 직접 한다. 에이전트는 커밋하지 않는다.',
    '지금 할 일: 커밋 메시지를 commit_draft_save 도구로 저장하고, 사용자에게 커밋할 준비가 됐다고 알려라.',
  ].join('\n'));
});

test('push 거절 안내문', async () => {
  const r = await setup().run(['push', 'origin', 'main']);
  expect(r.err.trim()).toBe('[두레] git push 는 사용자가 두레 화면에서 직접 한다. 에이전트는 push 하지 않는다.');
});

test('넘길 때 인자가 그대로다: 공백, 따옴표, 줄바꿈, $(…)', async () => {
  const marker = join(tempDir(), 'pwned');
  const args = ['log', '--grep', `a b "q" 'r' $(touch ${marker}) \`x\``, '-C', '두 번째\n줄'];
  const r = await setup().run(args);
  expect(r.out).toBe(args.map((a) => `ARG:${a}|\n`).join(''));
  expect((await import('node:fs')).existsSync(marker)).toBe(false);
});

test('넘길 때 진짜 git 의 종료 코드와 표준 입력이 그대로 전해진다', async () => {
  const r = await setup().run(['hash-object', '--stdin'], '입력 그대로\n');
  expect(r.code).toBe(7);
  expect(r.out).toContain('입력 그대로\n');
});
