import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let ws: Workspace;
beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  const projectId = core.projects.create('쇼핑몰').id;
  const repoPath = makeRepo('shop');
  writeFileSync(join(repoPath, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(repoPath, 'gone.txt'), 'bye\n');
  gitOut(repoPath, 'add', '-A');
  gitOut(repoPath, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'files');
  const repo = await core.addRepo(projectId, repoPath);
  ws = await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('고친 파일, 지운 파일, 스테이징한 파일의 변경을 통합 diff 로 돌려준다', async () => {
  const dir = ws.worktreePath;
  writeFileSync(join(dir, 'a.txt'), 'one\n2\nthree\nfour\n');
  unlinkSync(join(dir, 'gone.txt'));
  gitOut(dir, 'add', 'a.txt');
  const a = await core.commit.diff(ws.id, 'a.txt');
  expect(a).toMatchObject({ binary: false, truncated: false });
  expect(a.text).toContain('-two');
  expect(a.text).toContain('+2');
  expect(a.text).toContain('+four');
  expect((await core.commit.diff(ws.id, 'gone.txt')).text).toContain('-bye');
});

test('새 파일은 내용 전체를 추가된 줄로 보여 준다. 이름에 공백·한글·특수 글자가 있어도 된다', async () => {
  const dir = ws.worktreePath;
  mkdirSync(join(dir, '새 폴더'));
  writeFileSync(join(dir, '새 폴더', ':(glob)*.md'), '첫 줄\n둘째 줄\n');
  const d = await core.commit.diff(ws.id, '새 폴더/:(glob)*.md');
  expect(d.text.split('\n')).toEqual(['새 파일: 새 폴더/:(glob)*.md', '@@ -0,0 +1,2 @@', '+첫 줄', '+둘째 줄']);
});

test('이진 파일은 내용을 보내지 않고, 큰 파일은 잘라서 보낸다', async () => {
  const dir = ws.worktreePath;
  writeFileSync(join(dir, 'pic.bin'), Buffer.from([1, 2, 0, 3]));
  expect(await core.commit.diff(ws.id, 'pic.bin')).toEqual({ text: '', binary: true, truncated: false });
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(500_000));
  const big = await core.commit.diff(ws.id, 'big.txt');
  expect(big.truncated).toBe(true);
  expect(big.text.length).toBeLessThan(410_000);
});

test('바뀐 파일 목록에 없는 경로는 읽지 않는다. 심볼릭 링크는 가리키는 곳만 알려 준다', async () => {
  const dir = ws.worktreePath;
  await expect(core.commit.diff(ws.id, 'README.md')).rejects.toThrow('바뀐 파일이 아닙니다');
  await expect(core.commit.diff(ws.id, '../../etc/passwd')).rejects.toThrow('바뀐 파일이 아닙니다');
  await expect(core.commit.diff(ws.id, '/etc/passwd')).rejects.toThrow('바뀐 파일이 아닙니다');
  symlinkSync('/etc/passwd', join(dir, 'link'));
  const d = await core.commit.diff(ws.id, 'link');
  expect(d.text).toBe('새 심볼릭 링크 → /etc/passwd');
  expect(d.text).not.toContain('root:');
});
