import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { gitOut, makeRepo, tempDir } from '../helpers/repo';

let core: Core; let ws: Workspace; let dir: string; let projectId: string;
const write = (name: string, text: string): void => { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), text); };
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
// 줄 앞의 공백은 뗀다 (도우미가 출력의 앞뒤 공백을 떼어 첫 줄만 달라진다)
const status = (): string => gitOut(dir, 'status', '--porcelain').split('\n').map((l) => l.trim()).filter(Boolean).sort().join(' | ');
const commit = (msg: string): void => { gitOut(dir, 'add', '-A'); gitOut(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg); };

beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  projectId = core.projects.create('p').id;
  const repo = await core.addRepo(projectId, makeRepo('repo'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '화면', baseBranch: 'main', agentKind: 'claude' });
  dir = ws.worktreePath;
  write('.gitignore', '.env\nnode_modules/\n'); write('a.txt', 'a1\n'); write('src/b.txt', 'b1\n');
  commit('base');
});
afterEach(async () => { await core.dispose(); });

test('지점을 만드는 것은 작업 폴더도 스테이징 상태도 건드리지 않는다. 바뀐 것이 없으면 새로 만들지 않는다', async () => {
  write('a.txt', 'a2\n'); write('new.txt', 'n1\n');
  gitOut(dir, 'add', 'a.txt');
  const before = status();
  const head = gitOut(dir, 'rev-parse', 'HEAD');
  const c1 = await core.checkpoints.create(ws.id, '로그인 폼 만들어줘', 'auto');
  expect(status()).toBe(before);
  expect(before).toBe('?? new.txt | M  a.txt');
  expect(gitOut(dir, 'rev-parse', 'HEAD')).toBe(head);
  expect(core.checkpoints.list(ws.id)).toMatchObject([{ id: c1.id, label: '로그인 폼 만들어줘', kind: 'auto' }]);
  // 그대로면 같은 지점을 돌려준다 (저절로 만드는 것만)
  expect((await core.checkpoints.create(ws.id, '다음 말', 'auto')).id).toBe(c1.id);
  expect((await core.checkpoints.create(ws.id, '', 'manual')).id).not.toBe(c1.id);
  // git 이 정리해도 지워지지 않게 이름이 붙어 있다
  expect(gitOut(dir, 'for-each-ref', '--format=%(refname)', 'refs/dure/checkpoints').split('\n').length).toBe(2);
});

test('되돌리면 파일, 새로 생긴 파일, 지운 파일, 그 뒤의 커밋이 그때의 모습으로 돌아간다. 무시하는 파일은 그대로다', async () => {
  write('a.txt', 'a2 (커밋 안 함)\n'); write('note.txt', '그때 있던 새 파일\n'); write('.env', 'SECRET=1\n');
  const base = gitOut(dir, 'rev-parse', 'HEAD');
  const cp = await core.checkpoints.create(ws.id, '시작 전', 'auto');
  // 에이전트가 일했다: 고치고, 커밋하고, 새로 만들고, 지웠다
  write('a.txt', 'a3\n'); write('src/b.txt', 'b2\n'); write('src/deep/made.txt', '새로 만듦\n');
  commit('에이전트의 커밋');
  write('after.txt', '그 뒤의 새 파일\n'); rmSync(join(dir, 'note.txt')); write('.env', 'SECRET=2\n'); write('src/b.txt', 'b3\n');
  const later = gitOut(dir, 'rev-parse', 'HEAD');

  const preview = await core.checkpoints.preview(cp.id);
  expect(preview.commits).toBe(1);
  expect(preview.files.sort()).toEqual(['a.txt', 'after.txt', 'note.txt', 'src/b.txt', 'src/deep/made.txt']);

  const safety = await core.checkpoints.restore(cp.id);
  expect(read('a.txt')).toBe('a2 (커밋 안 함)\n');
  expect(read('src/b.txt')).toBe('b1\n');
  expect(read('note.txt')).toBe('그때 있던 새 파일\n');
  expect(existsSync(join(dir, 'after.txt'))).toBe(false);
  expect(existsSync(join(dir, 'src/deep/made.txt'))).toBe(false);
  expect(gitOut(dir, 'rev-parse', 'HEAD')).toBe(base);
  // 그때처럼: a.txt 는 바뀐 파일, note.txt 는 추적 안 된 파일
  expect(status()).toBe('?? note.txt | M a.txt');
  // 무시하는 파일은 건드리지 않았다
  expect(read('.env')).toBe('SECRET=2\n');

  // 되돌린 것을 무른다: 되돌리기 직전의 모습으로
  expect(safety.kind).toBe('safety');
  await core.checkpoints.restore(safety.id);
  expect(gitOut(dir, 'rev-parse', 'HEAD')).toBe(later);
  expect(read('a.txt')).toBe('a3\n');
  expect(read('src/b.txt')).toBe('b3\n');
  expect(read('after.txt')).toBe('그 뒤의 새 파일\n');
  expect(read('src/deep/made.txt')).toBe('새로 만듦\n');
  expect(existsSync(join(dir, 'note.txt'))).toBe(false);
});

test('에이전트가 일하는 중이거나, 조율 에이전트이거나, 없는 지점이면 되돌리지 않는다', async () => {
  const cp = await core.checkpoints.create(ws.id, 'x', 'manual');
  core.workspaces.update(ws.id, { status: 'working' });
  await expect(core.checkpoints.restore(cp.id)).rejects.toThrow('일하는 중');
  core.workspaces.update(ws.id, { status: 'idle' });
  await expect(core.checkpoints.restore('nope')).rejects.toThrow('되돌리기 지점이 없습니다');
  const coordinator = core.coordinator.ensure(projectId);
  await expect(core.checkpoints.create(coordinator.id, 'x')).rejects.toThrow('워크스페이스가 아닙니다');
});

test('지점은 워크스페이스마다 30개까지 남긴다', async () => {
  for (let i = 0; i < 33; i += 1) { write('a.txt', `v${i}\n`); await core.checkpoints.create(ws.id, `지점 ${i}`, 'auto'); }
  const list = core.checkpoints.list(ws.id);
  expect(list.length).toBe(30);
  expect(list[0]!.label).toBe('지점 32');
  expect(gitOut(dir, 'for-each-ref', '--format=%(refname)', 'refs/dure/checkpoints').split('\n').length).toBe(30);
}, 60_000);
