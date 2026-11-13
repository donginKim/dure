import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

/** 그림 그리기: 에이전트가 SVG 나 Mermaid 로 그리면 두레가 워크스페이스 옆 패널의 "그림" 탭에 띄운다. */
export const figureTools: ToolBundle = (server, ctx, deps) => {
  server.registerTool(
    'figure_show',
    {
      description: [
        '그림을 두레 화면 옆 패널("그림" 탭)에 띄운다. 사용자가 "그림 그려줘", "도식으로 보여줘", "구조를 그려줘" 라고 하면 이것을 써라 (파일로만 만들고 끝내지 마라).',
        'mermaid: 순서도, 시퀀스, 클래스, ER, 상태, 간트 같은 도식은 Mermaid 로 써라 (두레가 그림으로 바꾼다). 글자에는 한국어를 써도 된다.',
        'svg: 그 밖의 그림(화면 시안, 아이콘, 배치도, 차트)은 SVG 하나로 써라. <svg> 에 viewBox 를 주고, 스크립트와 바깥 파일(이미지 주소, 글꼴)은 쓰지 마라 (두레는 그림을 이미지로만 띄워 그것들은 돌지 않는다).',
        '고쳐 달라고 하면 replaces 에 앞의 그림 id 를 주고 다시 그려라: 같은 그림의 새 판으로 쌓인다.',
      ].join(' '),
      inputSchema: {
        title: z.string().describe('그림 제목 (짧게)'),
        mermaid: z.string().optional().describe('Mermaid 코드 (도식). svg 와 둘 중 하나'),
        svg: z.string().optional().describe('SVG 전체 (<svg ...>...</svg>). mermaid 와 둘 중 하나'),
        note: z.string().optional().describe('그림에 붙일 한 줄 설명'),
        replaces: z.string().optional().describe('고치는 그림의 id (figure_list)'),
      },
    },
    async ({ title, mermaid, svg, note, replaces }) => {
      try {
        if (Boolean(mermaid?.trim()) === Boolean(svg?.trim())) return fail('mermaid 와 svg 중 하나만 줘라.');
        const f = deps.figures.show(ctx.project.id, ctx.workspace.id, mermaid?.trim() ? { title, kind: 'mermaid', source: mermaid, note, replaces } : { title, kind: 'svg', source: svg, note, replaces });
        return ok({ id: f.id, version: f.version, shown: '사용자의 화면 옆 패널 "그림" 탭에 보인다. Mermaid 문법이 틀리면 거기에 오류가 보인다: 사용자가 알려 주면 고쳐 다시 그려라.' });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'figure_list',
    { description: '이 워크스페이스에서 그린 그림의 목록 (id, 제목, 판). 그림을 고칠 때 replaces 에 쓸 id 를 찾는다.', inputSchema: {} },
    async () => {
      const seen = new Set<string>();
      // 그림마다 가장 새 판만.
      const latest = deps.figures.list(ctx.workspace.id).filter((f) => (seen.has(f.groupId) ? false : (seen.add(f.groupId), true)));
      return ok({ figures: latest.map((f) => ({ id: f.id, title: f.title, kind: f.kind, version: f.version })) });
    },
  );
};
