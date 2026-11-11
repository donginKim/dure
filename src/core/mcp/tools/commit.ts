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
};
