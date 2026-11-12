import { z } from 'zod';
import { BROWSER_KEYS, type PageSnapshot } from '../../browserService';
import type { ToolBundle } from '../server';

const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true });
const page = (s: PageSnapshot) => ({ content: [{ type: 'text' as const, text: `주소: ${s.url}\n제목: ${s.title}\n누르거나 입력할 수 있는 것: ${s.refs}개 ([번호] 로 표시)\n\n${s.text}` }] });

/**
 * 내장 브라우저 도구. 이 워크스페이스의 "브라우저" 보기에 보이는 페이지를 에이전트가 열고, 읽고, 누른다.
 * 자기가 만든 화면을 띄워 확인하는 용도다. 로컬 주소와 사용자가 허용한 주소만 된다.
 */
export const browserTools: ToolBundle = (server, ctx, deps) => {
  // 조율 에이전트는 코드를 만들지 않는다: 띄워 볼 화면이 없다.
  if (ctx.workspace.role === 'coordinator') return;
  const id = ctx.workspace.id;
  const run = async (fn: () => Promise<PageSnapshot>) => { try { return page(await fn()); } catch (e) { return fail(e); } };

  server.registerTool(
    'browser_open',
    {
      description: [
        '두레의 내장 브라우저로 주소를 연다. 사용자의 화면("브라우저" 보기)에 그대로 보인다. 네가 띄운 개발 서버의 화면을 확인할 때 쓴다.',
        '로컬 주소(localhost, 127.0.0.1)와 사용자가 두레 설정에 허용한 주소만 열 수 있다.',
        '돌려주는 것: 페이지에 보이는 내용. 누르거나 입력할 수 있는 요소에는 [번호] 가 붙는다. 그 번호를 browser_click, browser_type 에 준다.',
      ].join(' '),
      inputSchema: { url: z.string().describe('예: http://localhost:3000') },
    },
    async ({ url }) => run(() => deps.browser.open(id, url)),
  );

  server.registerTool(
    'browser_snapshot',
    { description: '지금 열린 페이지에 보이는 내용을 다시 읽는다. 번호는 읽을 때마다 새로 붙는다.', inputSchema: {} },
    async () => run(() => deps.browser.snapshot(id)),
  );

  server.registerTool(
    'browser_click',
    { description: '요소를 누른다. 누른 뒤의 페이지를 돌려준다.', inputSchema: { ref: z.number().int().describe('browser_snapshot 이 붙인 번호') } },
    async ({ ref }) => run(() => deps.browser.click(id, ref)),
  );

  server.registerTool(
    'browser_type',
    {
      description: '입력칸에 글을 넣는다 (있던 글은 지워진다). submit 을 주면 Enter 를 누른다. 넣은 뒤의 페이지를 돌려준다. 비밀번호 같은 비밀 값을 넣지 마라.',
      inputSchema: { ref: z.number().int(), text: z.string(), submit: z.boolean().optional() },
    },
    async ({ ref, text, submit }) => run(() => deps.browser.type(id, ref, text, { submit })),
  );

  server.registerTool(
    'browser_press',
    { description: '키 하나를 누른다 (초점이 있는 곳에). 누른 뒤의 페이지를 돌려준다.', inputSchema: { key: z.enum(BROWSER_KEYS) } },
    async ({ key }) => run(() => deps.browser.press(id, key)),
  );

  server.registerTool(
    'browser_screenshot',
    { description: '지금 보이는 화면을 그림으로 받는다. 배치나 모양을 눈으로 확인해야 할 때만 써라 (내용은 browser_snapshot 이 더 싸다).', inputSchema: {} },
    async () => {
      try {
        const s = await deps.browser.screenshot(id);
        return { content: [{ type: 'text' as const, text: `주소: ${s.url}` }, { type: 'image' as const, data: s.data, mimeType: s.mimeType }] };
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'browser_console',
    { description: '페이지의 최근 콘솔 경고·오류와 불러오지 못한 것을 본다. 화면이 기대와 다를 때 원인을 찾는 데 쓴다.', inputSchema: {} },
    async () => {
      try {
        const r = await deps.browser.logs(id);
        return { content: [{ type: 'text' as const, text: `주소: ${r.url}\n${r.lines.length ? r.lines.join('\n') : '(경고나 오류가 없다)'}` }] };
      } catch (e) { return fail(e); }
    },
  );
};
