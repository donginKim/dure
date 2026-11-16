import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@core/db';
import { PluginService } from '@core/plugins';
import { SettingsService } from '@core/settings';

const URL = 'https://example.com/team/plugins.git';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dure-market-'));
  const repo = join(root, 'repo');
  const put = (dir: string, manifest: Record<string, unknown>): void => { mkdirSync(join(repo, dir), { recursive: true }); writeFileSync(join(repo, dir, 'plugin.json'), JSON.stringify(manifest)); };
  put('news', { id: 'news', name: '뉴스', version: '1.0.0', description: '머리기사', panels: [{ title: '국내', feeds: [{ name: '가', url: 'https://feeds.example.com/rss' }] }] });
  put('kit', { id: 'kit', name: '보고 양식', version: '1.0.0', makers: [{ name: '주간 보고', prompt: '세 줄 요약' }], schedules: [{ title: '아침 정리', prompt: '할 일 정리', kind: 'daily', time: '09:00' }] });
  put('tool', { id: 'tool', name: '도구', version: '0.1.0', instructions: '규칙을 지켜라', mcpServers: { search: { url: 'https://mcp.example.com' } } });
  mkdirSync(join(repo, 'docs'), { recursive: true }); // plugin.json 이 없는 폴더는 건너뛴다
  let clones = 0; let fail = false;
  const svc = new PluginService({
    db: openDatabase(':memory:'), dir: join(root, 'plugins'), addMemory: () => undefined,
    git: async (args) => { if (!args.includes('clone')) return ''; clones++; if (fail) throw new Error('fatal: could not read from remote'); cpSync(repo, args[args.length - 1]!, { recursive: true }); return ''; },
  });
  return { svc, put, clones: () => clones, setFail: (v: boolean) => { fail = v; } };
}

test('마켓: 모음에 든 플러그인과 담긴 것의 갈래를 보인다', async () => {
  const { svc } = setup();
  const [src] = await svc.market([{ url: URL, base: true }]);
  expect(src).toMatchObject({ url: URL, label: 'team/plugins', base: true, error: '' });
  expect(src!.entries.map((e) => [e.dir, e.kinds, e.installed])).toEqual([
    ['kit', ['makers', 'schedules'], false],
    ['news', ['panels'], false],
    ['tool', ['instructions', 'mcp'], false],
  ]);
  expect(src!.entries[0]!.contents).toEqual({ panels: [], makers: ['주간 보고'], schedules: ['아침 정리'], mcp: [] });
  expect(src!.entries[2]!.contents.mcp).toEqual(['search']);
});

test('마켓: 받아 둔 것을 다시 쓰고, 설치 여부와 새 판은 지금 것으로 보인다', async () => {
  const { svc, put, clones } = setup();
  await svc.market([{ url: URL, base: true }]);
  await svc.market([{ url: URL, base: true }]);
  expect(clones()).toBe(1);
  await svc.installFromGit(`${URL}#kit`);
  expect(clones()).toBe(2);
  let kit = (await svc.market([{ url: URL, base: true }]))[0]!.entries.find((e) => e.id === 'kit')!;
  expect(clones()).toBe(2); // 설치했다고 모음을 다시 받지 않는다
  expect(kit).toMatchObject({ installed: true, installedVersion: '1.0.0', version: '1.0.0' });
  // 모음에 새 판이 올라오면, 새로 받았을 때 설치된 판과 달라 보인다
  put('kit', { id: 'kit', name: '보고 양식', version: '1.1.0', makers: [{ name: '주간 보고', prompt: '네 줄 요약' }] });
  kit = (await svc.market([{ url: URL, base: true }], true))[0]!.entries.find((e) => e.id === 'kit')!;
  expect(kit).toMatchObject({ installed: true, installedVersion: '1.0.0', version: '1.1.0' });
  // 올린 뒤에는 내용이 바뀌어 다시 승인해야 한다
  const before = svc.list().find((p) => p.id === 'kit')!;
  svc.approve('kit', before.hash);
  await svc.installFromGit(`${URL}#kit`);
  expect(svc.list().find((p) => p.id === 'kit')).toMatchObject({ version: '1.1.0', approved: false, changed: true });
});

test('마켓: 받지 못한 모음은 까닭을 보이고, 앞서 받은 목록과 다른 모음은 그대로 둔다', async () => {
  const { svc, setFail } = setup();
  await svc.market([{ url: URL, base: true }]);
  setFail(true);
  const out = await svc.market([{ url: URL, base: true }, { url: 'git@example.com:other/more.git', base: false }], true);
  expect(out[0]!.error).toContain('could not read');
  expect(out[0]!.entries).toHaveLength(3);
  expect(out[1]).toMatchObject({ label: 'other/more', base: false, entries: [] });
  expect(out[1]!.error).not.toBe('');
  await expect(svc.market([{ url: 'file:///etc', base: false }])).resolves.toMatchObject([{ entries: [], error: expect.stringContaining('git 주소') }]);
});

test('설정: 더한 모음은 git 주소만, 10개까지, 겹치지 않게', () => {
  const s = new SettingsService(openDatabase(':memory:'));
  expect(s.get().pluginSources).toEqual([]);
  expect(s.update({ pluginSources: [' https://example.com/a.git ', 'https://example.com/a.git', 'git@example.com:b/c.git'] }).pluginSources).toEqual(['https://example.com/a.git', 'git@example.com:b/c.git']);
  expect(() => s.update({ pluginSources: ['file:///etc/passwd'] })).toThrow('git 주소');
  expect(() => s.update({ pluginSources: ['https://example.com/a.git --upload-pack=x'] })).toThrow('git 주소');
  expect(() => s.update({ pluginSources: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.git`) })).toThrow('10개');
  expect(() => s.update({ pluginSources: 'https://example.com/a.git' as never })).toThrow();
  expect(s.get().pluginSources).toHaveLength(2);
});
