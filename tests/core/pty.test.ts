import { PtyManager, type SpawnOptions } from '@core/pty';
import { tempDir } from '../helpers/repo';

const env = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' };
const base = (over: Partial<SpawnOptions>): SpawnOptions => ({
  workspaceId: 'w1', kind: 'shell', title: 't', command: '/bin/sh', args: [], cwd: tempDir(), env, cols: 80, rows: 24, ...over,
});

function until(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => (cond() ? resolve() : Date.now() > end ? reject(new Error('timeout')) : setTimeout(tick, 20));
    tick();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let mgr: PtyManager;
beforeEach(() => { mgr = new PtyManager(); });
afterEach(() => { mgr.killAll(); });

test('spawn 한 프로세스의 출력이 data 이벤트로 온다', async () => {
  let out = '';
  mgr.on('data', (_id, chunk) => { out += chunk; });
  const t = mgr.spawn(base({ args: ['-c', 'echo dure-hi'] }));
  expect(t).toMatchObject({ workspaceId: 'w1', kind: 'shell', title: 't' });
  await until(() => out.includes('dure-hi'));
});

test('write 한 입력이 프로세스에 전달된다', async () => {
  const t = mgr.spawn(base({ command: '/bin/cat' }));
  mgr.write(t.id, 'abc\n');
  await until(() => mgr.buffer(t.id).split('abc').length >= 3); // 입력 에코 + cat 출력
});

test('공백·한글이 든 cwd 에서 실행된다', async () => {
  const cwd = tempDir('두레 작업 폴더 ');
  const t = mgr.spawn(base({ cwd, args: ['-c', 'pwd; sleep 5'] }));
  await until(() => mgr.buffer(t.id).includes(cwd));
});

test('exit 이벤트 뒤 list 에서 빠진다', async () => {
  let exit: { id: string; code: number } | undefined;
  mgr.on('exit', (id, code) => { exit = { id, code }; });
  const t = mgr.spawn(base({ args: ['-c', 'exit 3'] }));
  expect(mgr.list('w1').map((x) => x.id)).toContain(t.id);
  await until(() => exit !== undefined);
  expect(exit).toEqual({ id: t.id, code: 3 });
  expect(mgr.list('w1')).toEqual([]);
});

test('list 는 워크스페이스별로 나눈다', () => {
  const a = mgr.spawn(base({ workspaceId: 'a', command: '/bin/cat' }));
  mgr.spawn(base({ workspaceId: 'b', command: '/bin/cat' }));
  expect(mgr.list('a').map((x) => x.id)).toEqual([a.id]);
});

test('buffer 는 최근 200_000자만 보관한다', async () => {
  const t = mgr.spawn(base({ args: ['-c', 'head -c 250000 /dev/zero | tr "\\0" "x"; echo END; sleep 5'] }));
  await until(() => mgr.buffer(t.id).includes('END'), 10000);
  expect(mgr.buffer(t.id).length).toBe(200_000);
});

test('없는 id 에 대한 write/resize/kill 은 조용히 무시한다', () => {
  expect(() => { mgr.write('nope', 'x'); mgr.resize('nope', 10, 10); mgr.kill('nope'); }).not.toThrow();
  expect(mgr.buffer('nope')).toBe('');
});

test('killAll 뒤 자식 프로세스가 남지 않는다', async () => {
  const a = mgr.spawn(base({ command: '/bin/sleep', args: ['1000'] }));
  const b = mgr.spawn(base({ command: '/bin/sleep', args: ['1000'] }));
  const pids = [mgr.pid(a.id), mgr.pid(b.id)];
  expect(pids.every(alive)).toBe(true);
  mgr.killAll();
  await until(() => pids.every((p) => !alive(p)), 2000);
});

test('data 이벤트의 끝 위치와 snapshot 의 끝 위치로 겹치는 출력을 가려낼 수 있다', async () => {
  const ends: number[] = [];
  let seen = '';
  mgr.on('data', (_id, chunk: string, end: number) => { seen += chunk; ends.push(end); });
  const t = mgr.spawn(base({ args: ['-c', 'echo one; sleep 0.3; echo two; sleep 5'] }));
  await until(() => seen.includes('one'));
  const snap = mgr.snapshot(t.id);
  expect(snap.data).toContain('one');
  expect(snap.end).toBe(snap.data.length);
  await until(() => seen.includes('two'));
  expect(ends).toEqual([...ends].sort((a, b) => a - b));
  expect(ends[ends.length - 1]).toBe(seen.length);
  expect(ends[ends.length - 1]).toBeGreaterThan(snap.end); // snapshot 뒤에 온 조각은 끝 위치가 더 크다
  expect(mgr.snapshot('nope')).toEqual({ data: '', end: 0 });
});
