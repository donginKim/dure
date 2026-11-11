import { openDatabase } from '@core/db';
import { DEFAULT_SETTINGS, SettingsService, expandHome, parseArgs, reservedArg } from '@core/settings';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../helpers/repo';

const fresh = (): SettingsService => new SettingsService(openDatabase(':memory:'));

test('처음에는 기본값이다', () => {
  expect(fresh().get()).toEqual(DEFAULT_SETTINGS);
  expect(DEFAULT_SETTINGS).toMatchObject({ defaultEngine: 'chat', defaultAgent: 'claude', defaultPermissionMode: 'ask', threadCap: 10, projectCap: 50, autoTrust: true });
});

test('바꾼 것만 바뀌고, changed 가 나고, 다시 열어도 남는다', () => {
  const file = join(tempDir(), 's.db');
  const s = new SettingsService(openDatabase(file));
  let changed = 0;
  s.on('changed', () => { changed++; });
  expect(s.update({ threadCap: 3, defaultEngine: 'terminal', claudeModel: ' opus ' })).toMatchObject({ threadCap: 3, defaultEngine: 'terminal', claudeModel: 'opus', projectCap: 50 });
  expect(changed).toBe(1);
  expect(new SettingsService(openDatabase(file)).get()).toMatchObject({ threadCap: 3, defaultEngine: 'terminal', claudeModel: 'opus' });
});

test('get 이 돌려준 것을 고쳐도 설정은 바뀌지 않는다', () => {
  const s = fresh();
  s.get().threadCap = 999;
  expect(s.get().threadCap).toBe(10);
});

test('하나라도 틀리면 아무것도 바뀌지 않고 이유를 알려 준다', () => {
  const s = fresh();
  expect(() => s.update({ threadCap: 5, projectCap: 0 })).toThrow('프로젝트 전체의 상한');
  expect(s.get().threadCap).toBe(10);
  expect(() => s.update({ nope: 1 } as never)).toThrow('모르는 설정입니다: nope');
  expect(() => s.update(null as never)).toThrow();
});

test.each([
  [{ defaultAgent: 'gpt' }, '기본 에이전트'],
  [{ defaultEngine: 'web' }, '기본 방식'],
  [{ defaultPermissionMode: 'yolo' }, '기본 권한 모드'],
  [{ threadCap: 1.5 }, '정수'],
  [{ threadCap: '3' }, '정수'],
  [{ autoTrust: 'yes' }, '켜기/끄기'],
  [{ terminalFontSize: 100 }, '사이여야'],
  [{ worktreeRoot: 'relative/path' }, '전체 경로'],
  [{ claudePath: 'claude' }, '전체 경로'],
  [{ claudeModel: 'opus; rm -rf /' }, '쓸 수 없는 글자'],
  [{ claudeArgs: '--effort "high' }, '따옴표가 닫히지 않았습니다'],
  [{ claudeArgs: '--dangerously-skip-permissions' }, '두레가 직접 정하는 인자'],
  [{ claudeArgs: '--permission-mode=bypassPermissions' }, '두레가 직접 정하는 인자'],
  [{ claudeArgs: '--effort high --mcp-config /tmp/x.json' }, '--mcp-config'],
  [{ claudeArgs: '--model opus' }, '--model'],
  [{ codexArgs: '--dangerously-bypass-approvals-and-sandbox' }, '두레가 직접 정하는 인자'],
  [{ codexArgs: '-c sandbox_mode="danger-full-access"' }, '-c'],
])('틀린 값 %j 은 거절한다', (patch, reason) => {
  expect(() => fresh().update(patch as never)).toThrow(reason);
});

test('받는 값: 경로, 인자, 글자 크기', () => {
  const s = fresh();
  expect(s.update({ worktreeRoot: ' ~/work/dure ', claudePath: '/opt/bin/claude', claudeArgs: ' --effort high  --add-dir "/a b" ', chatFontSize: 14.26, autoTrust: false }))
    .toMatchObject({ worktreeRoot: '~/work/dure', claudePath: '/opt/bin/claude', claudeArgs: '--effort high  --add-dir "/a b"', chatFontSize: 14.5, autoTrust: false });
  expect(s.update({ worktreeRoot: '', claudeArgs: '' })).toMatchObject({ worktreeRoot: '', claudeArgs: '' });
});

test('reset 은 그 설정만 기본값으로 되돌린다', () => {
  const s = fresh();
  s.update({ threadCap: 3, projectCap: 7 });
  expect(s.reset('threadCap')).toMatchObject({ threadCap: 10, projectCap: 7 });
  expect(() => s.reset('nope' as never)).toThrow('모르는 설정');
});

test('저장된 값이 규칙에 맞지 않으면(손으로 고침) 그 설정만 기본값을 쓴다', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?)').run('threadCap', '"많이"', 'projectCap', '70', 'claudeArgs', '"--dangerously-skip-permissions"', 'oldKey', '1');
  expect(new SettingsService(db).get()).toMatchObject({ threadCap: 10, projectCap: 70, claudeArgs: '' });
});

test('parseArgs: 공백으로 나누고 따옴표로 묶는다', () => {
  expect(parseArgs('')).toEqual([]);
  expect(parseArgs('  --effort   high ')).toEqual(['--effort', 'high']);
  expect(parseArgs(`--add-dir "/a b" --x='c d' ""`)).toEqual(['--add-dir', '/a b', '--x=c d', '']);
  expect(parseArgs('a"b c"d')).toEqual(['ab cd']);
  expect(parseArgs('$(whoami) `id` $HOME')).toEqual(['$(whoami)', '`id`', '$HOME']); // 셸로 풀리지 않는다
  expect(() => parseArgs(`--x 'oops`)).toThrow('따옴표');
});

test('reservedArg: 두레가 정하는 인자를 찾아낸다', () => {
  expect(reservedArg('claude', ['--effort', 'high'])).toBeUndefined();
  expect(reservedArg('claude', ['--effort', 'high', '--settings=/x'])).toBe('--settings=/x');
  expect(reservedArg('codex', ['--search'])).toBeUndefined();
  expect(reservedArg('codex', ['--full-auto'])).toBe('--full-auto');
});

test('expandHome', () => {
  expect(expandHome('~/a/b')).toBe(join(homedir(), 'a/b'));
  expect(expandHome('/x/y')).toBe('/x/y');
  expect(expandHome('')).toBe('');
});
