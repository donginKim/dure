import { join } from 'node:path';
import { createCore, type Core } from '@core/index';
import type { Workspace } from '@shared/types';
import { fileName, groupFigures, svgDataUrl } from '../../src/renderer/figureView';
import { makeRepo, tempDir } from '../helpers/repo';

let core: Core;
let ws: Workspace;
async function call(workspaceId: string, name: string, args: unknown = {}): Promise<string> {
  const res = await fetch(core.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${core.workspaces.getToken(workspaceId)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.text();
}
beforeEach(async () => {
  core = await createCore({ dataDir: join(tempDir(), 'data'), worktreeRoot: join(tempDir(), 'wt'), baseEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: tempDir() }, claudeDir: tempDir() });
  const projectId = core.projects.create('쇼핑몰').id;
  const repo = await core.addRepo(projectId, makeRepo('shop'));
  ws = await core.service.create({ projectId, repoId: repo.id, name: '백엔드', baseBranch: 'main', agentKind: 'claude' });
});
afterEach(async () => { await core.dispose(); });

test('에이전트가 그림을 올리면 그 워크스페이스에 쌓인다. 고치면 같은 그림의 새 판이 된다', async () => {
  const first = await call(ws.id, 'figure_show', { title: '로그인 흐름', mermaid: 'flowchart LR\n  A[화면] --> B[API]' });
  expect(first).toContain('\\"version\\":1');
  const f1 = core.figures.list(ws.id)[0]!;
  expect(f1).toMatchObject({ title: '로그인 흐름', kind: 'mermaid', version: 1 });
  expect(await call(ws.id, 'figure_show', { title: '로그인 흐름', mermaid: 'flowchart LR\n  B[API] --> A[화면]', replaces: f1.id })).toContain('\\"version\\":2');
  await call(ws.id, 'figure_show', { title: '아이콘', svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' });
  const all = core.figures.list(ws.id);
  expect(all.length).toBe(3);
  // 이름공간이 없으면 붙인다 (이미지로 띄울 때 필요하다)
  expect(all.find((f) => f.kind === 'svg')!.source).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox/);
  // figure_list 는 그림마다 가장 새 판만
  const list = await call(ws.id, 'figure_list');
  expect(list).toContain('로그인 흐름');
  expect(list.match(/로그인 흐름/g)!.length).toBe(1);
  expect(groupFigures(all).map((g) => [g.title, g.versions.map((v) => v.version)])).toEqual([['아이콘', [1]], ['로그인 흐름', [2, 1]]]);
});

test('모양이 틀리거나 너무 큰 그림, 남의 그림을 고치려는 것은 받지 않는다', async () => {
  expect(await call(ws.id, 'figure_show', { title: 'x' })).toContain('하나만 줘라');
  expect(await call(ws.id, 'figure_show', { title: 'x', svg: '<svg/>', mermaid: 'graph TD' })).toContain('하나만 줘라');
  expect(await call(ws.id, 'figure_show', { title: 'x', svg: '<div>not svg</div>' })).toContain('<svg ...> 로 시작해');
  expect(await call(ws.id, 'figure_show', { title: 'x', svg: `<svg>${'a'.repeat(700_000)}</svg>` })).toContain('너무 크다');
  expect(await call(ws.id, 'figure_show', { title: 'x', mermaid: 'graph TD', replaces: 'nope' })).toContain('고치려는 그림이 없다');
  // XML 선언이 앞에 있어도 받는다
  expect(await call(ws.id, 'figure_show', { title: 'x', svg: '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>' })).toContain('\\"version\\":1');
  // 다른 워크스페이스의 그림을 고칠 수 없다
  const other = await core.service.create({ projectId: ws.projectId, repoId: ws.repoId, name: '화면', baseBranch: 'main', agentKind: 'claude' });
  const mine = core.figures.list(ws.id)[0]!;
  expect(await call(other.id, 'figure_show', { title: 'y', mermaid: 'graph TD', replaces: mine.id })).toContain('고치려는 그림이 없다');
});

test('화면 도우미: 이미지 주소, 파일 이름', () => {
  expect(svgDataUrl('<svg/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
  expect(fileName('로그인 흐름: v2/최종', 'png')).toBe('로그인_흐름_v2_최종.png');
  expect(fileName('', 'svg')).toBe('figure.svg');
});
