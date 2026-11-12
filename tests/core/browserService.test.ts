import { join } from 'node:path';
import { allowedUrl, parseHosts, type BrowserDriver } from '@core/browserService';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { createBrowserStore } from '../../src/renderer/browserStore';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let projectId: string;
let ws: Workspace;
let page: { url: string; title: string; lines: string[]; refs: number; cut: boolean };
let calls: string[];
let elements: Record<number, 'input' | 'button' | 'disabled'>;

const driver: BrowserDriver = {
  ensure: async (_id, url) => { calls.push(`ensure ${url}`); },
  navigate: async (_id, url) => { calls.push(`navigate ${url}`); page = { ...page, url }; },
  info: async () => ({ url: page.url, title: page.title }),
  // 페이지 안에서 도는 글을 흉내 낸다: 어떤 글이 왔는지 보고 그 결과를 돌려준다.
  evaluate: async (_id, expr) => {
    if (expr.includes('const MAX =')) return page;
    if (expr.includes("new KeyboardEvent('keydown'")) { calls.push(`key ${/const key = "(\w+)"/.exec(expr)?.[1]}`); return { ok: true }; }
    const ref = Number(/data-dure-ref="(\d+)"/.exec(expr)?.[1]);
    const el = elements[ref];
    if (!el) return { missing: true };
    if (el === 'disabled') return { disabled: true };
    if (expr.includes("new InputEvent('input'")) {
      if (el !== 'input') return { notInput: 'button' };
      calls.push(`type ${ref} ${/\.set\.call\(el, (".*?")\);/.exec(expr)?.[1]}`);
      return { ok: true };
    }
    calls.push(`click ${ref}`);
    return { ok: true };
  },
  idle: async () => undefined,
  screenshot: async () => ({ data: 'AAAA', mimeType: 'image/jpeg' }),
  logs: () => ['[오류] boom', '[경고] slow'],
};

async function call(workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}

beforeEach(async () => {
  calls = [];
  page = { url: '', title: '', lines: ['제목1: 할 일', '[1] 입력(text) "새 할 일"', '[2] 버튼 "추가"'], refs: 2, cut: false };
  elements = { 1: 'input', 2: 'button', 3: 'disabled' };
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir(), browser: driver });
  projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '프론트', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('allowedUrl: 로컬 주소와 허용한 호스트(하위 도메인 포함)만 된다', () => {
  for (const ok of ['http://localhost:3000', 'http://127.0.0.1:5173/a', 'http://[::1]:8080/', 'http://app.localhost:3000', 'https://localhost']) expect(allowedUrl(ok, [])).toBe(true);
  for (const bad of ['https://example.com', 'http://localhost.evil.com', 'http://evil.com/localhost', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@localhost:3000', 'ftp://localhost', 'nope', 'http://127.0.0.1.evil.com', 'http://192.168.0.5:3000']) expect(allowedUrl(bad, [])).toBe(false);
  const hosts = parseHosts('staging.example.com, https://docs.test.dev/path  bad_host localhost nodot');
  expect(hosts).toEqual(['staging.example.com', 'docs.test.dev']);
  expect(allowedUrl('https://staging.example.com/x', hosts)).toBe(true);
  expect(allowedUrl('https://api.staging.example.com', hosts)).toBe(true);
  expect(allowedUrl('https://example.com', hosts)).toBe(false);
  expect(allowedUrl('https://notstaging.example.com', hosts)).toBe(false);
  expect(allowedUrl('https://staging.example.com.evil.io', hosts)).toBe(false);
});

test('browser_open: 페이지를 만들고 주소를 연 뒤, 보이는 내용을 번호와 함께 돌려준다', async () => {
  const text = await call(ws.id, 'browser_open', { url: 'localhost:3000' });
  expect(calls).toEqual(['ensure http://localhost:3000', 'navigate http://localhost:3000']);
  expect(text).toContain('주소: http://localhost:3000');
  expect(text).toContain('[2] 버튼 \\"추가\\"');
  expect(text).toContain('누르거나 입력할 수 있는 것: 2개');
});

test('허용되지 않은 주소는 열지 않는다. 사용자가 설정에 적으면 열 수 있다', async () => {
  expect(await call(ws.id, 'browser_open', { url: 'https://example.com' })).toContain('이 주소는 에이전트가 볼 수 없다');
  expect(await call(ws.id, 'browser_open', { url: 'file:///etc/passwd' })).toContain('볼 수 없다');
  expect(calls).toEqual([]);
  core.settings.update({ agentBrowserHosts: 'example.com' });
  expect(await call(ws.id, 'browser_open', { url: 'https://example.com' })).toContain('주소: https://example.com');
  expect(() => core.settings.update({ agentBrowserHosts: 'http://x.com/path' })).toThrow('호스트 이름만');
});

test('사용자가 같은 페이지를 다른 곳으로 옮겼으면 그 내용을 읽거나 조작하지 못한다', async () => {
  await call(ws.id, 'browser_open', { url: 'http://localhost:3000' });
  page = { ...page, url: 'https://mail.example.com/inbox', lines: ['비밀 메일'] };
  calls = [];
  for (const [tool, args] of [['browser_snapshot', {}], ['browser_click', { ref: 2 }], ['browser_type', { ref: 1, text: 'x' }], ['browser_press', { key: 'Enter' }], ['browser_screenshot', {}], ['browser_console', {}]] as const) {
    const text = await call(ws.id, tool, args);
    expect(text).toContain('이 주소는 에이전트가 볼 수 없다');
    expect(text).not.toContain('비밀 메일');
    expect(text).not.toContain('AAAA');
    expect(text).not.toContain('boom');
  }
  expect(calls).toEqual([]);
});

test('누르기와 입력: 번호로 요소를 찾아 조작하고, 바뀐 페이지를 돌려준다', async () => {
  await call(ws.id, 'browser_open', { url: 'http://localhost:3000' });
  calls = [];
  expect(await call(ws.id, 'browser_type', { ref: 1, text: '우유 사기', submit: true })).toContain('주소: http://localhost:3000');
  expect(calls).toEqual(['type 1 "우유 사기"', 'key Enter']);
  calls = [];
  await call(ws.id, 'browser_click', { ref: 2 });
  expect(calls).toEqual(['click 2']);
  // 따옴표와 줄바꿈이 든 글도 페이지의 글을 깨지 않고 그대로 들어간다
  calls = [];
  await call(ws.id, 'browser_type', { ref: 1, text: 'a"b\\c' });
  expect(calls).toEqual(['type 1 "a\\"b\\\\c"']);
  expect(await call(ws.id, 'browser_click', { ref: 9 })).toContain('[9] 인 요소가 없다');
  expect(await call(ws.id, 'browser_click', { ref: 3 })).toContain('꺼져 있어');
  expect(await call(ws.id, 'browser_type', { ref: 2, text: 'x' })).toContain('글을 넣는 칸이 아니다');
  expect(await call(ws.id, 'browser_press', { key: 'F12' })).not.toContain('주소:');
});

test('화면 찍기와 콘솔: 그림과 최근 오류를 돌려준다', async () => {
  await call(ws.id, 'browser_open', { url: 'http://localhost:3000' });
  const shot = await call(ws.id, 'browser_screenshot');
  expect(shot).toContain('"type":"image"');
  expect(shot).toContain('AAAA');
  expect(await call(ws.id, 'browser_console')).toContain('[오류] boom');
});

test('열린 페이지가 없을 때, 설정에서 껐을 때, 완료된 프로젝트, 조율 에이전트', async () => {
  expect(await call(ws.id, 'browser_snapshot')).toContain('열린 페이지가 없다');
  core.settings.update({ agentBrowser: 'off' });
  expect(await call(ws.id, 'browser_open', { url: 'http://localhost:3000' })).toContain('꺼 두었다');
  core.settings.update({ agentBrowser: 'local' });
  const c = core.coordinator.ensure(projectId);
  expect(await call(c.id, 'browser_open', { url: 'http://localhost:3000' })).not.toContain('주소:');
  await core.completeProject(projectId, { removeWorktrees: [], removeItems: [], seen: {} });
  await expect(core.browser.open(ws.id, 'http://localhost:3000')).rejects.toThrow('완료된 프로젝트');
  expect(calls).toEqual([]);
});

test('화면의 페이지 보관소: 한 워크스페이스에 페이지 하나, 자리를 주고 빼기, 지워진 워크스페이스의 페이지 닫기', () => {
  const store = createBrowserStore();
  let n = 0;
  store.subscribe(() => { n++; });
  store.ensure('w1', 'http://localhost:3000');
  store.ensure('w1', 'http://localhost:9999', true);
  expect(store.all()).toEqual([{ workspaceId: 'w1', url: 'http://localhost:3000', rect: null, byAgent: true }]);
  store.setRect('w1', { left: 1, top: 2, width: 3, height: 4 });
  const before = n;
  store.setRect('w1', { left: 1, top: 2, width: 3, height: 4 });
  expect(n).toBe(before);
  store.setRect('w1', null);
  expect(store.get('w1')!.rect).toBeNull();
  store.ensure('w2', 'http://localhost:4000');
  store.keepOnly(new Set(['w2']));
  expect(store.all().map((e) => e.workspaceId)).toEqual(['w2']);
});
