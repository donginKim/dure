import { z } from 'zod';
import type { ToolBundle } from '../server';

/** 에이전트가 커밋 메시지 초안을 두레에 남기는 도구. 커밋은 사용자가 화면에서 한다. */
export const commitTools: ToolBundle = (server, ctx, deps) => {
  server.registerTool(
    'commit_draft_save',
    {
      description: '커밋 메시지 초안을 두레에 저장한다. 사용자가 두레 화면에서 이 메시지를 고쳐 직접 커밋한다. 다시 저장하면 덮어쓴다.',
      inputSchema: { message: z.string().describe('커밋 메시지 전체 (제목 줄, 빈 줄, 본문)') },
    },
    async ({ message }) => {
      try {
        deps.commitDrafts.save(ctx.workspace.id, message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true }) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  );

  server.registerTool(
    'pr_draft_save',
    {
      description: 'PR (병합 요청) 의 제목과 설명을 초안으로 두레에 저장한다. PR 을 만들지는 않는다: 사용자가 두레의 커밋 창에서 이 초안을 고쳐 직접 만든다. 다시 저장하면 덮어쓴다. 설명에는 무엇을 왜 바꿨는지, 어떻게 확인했는지를 적어라.',
      inputSchema: { title: z.string().describe('PR 의 제목 (한 줄)'), body: z.string().describe('PR 의 설명 (마크다운)') },
    },
    async ({ title, body }) => {
      try {
        deps.prs.saveDraft(ctx.workspace.id, { title, body });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ saved: true }) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
  );
};
