import { z } from 'zod';
import type { ToolBundle } from '../server';

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o) }] });

/** 최종 산출물이 아닌 파일을 지우지 않고 "정리 대기" 로 옮기는 도구. 지우는 것은 사용자가 프로젝트를 완료 처리할 때 한다. */
export const cleanupTools: ToolBundle = (server, ctx, deps) => {
  server.registerTool(
    'cleanup_stash',
    {
      description: [
        '최종 산출물이 아닌 파일이나 폴더를 두레의 "정리 대기" 로 옮긴다 (지우지 않는다. 사용자가 되돌릴 수 있다).',
        '옮길 것: 네가 작업하며 만든 실험용 스크립트, 로그, 디버그 출력, 임시 메모처럼 커밋에 들어가면 안 되는 것.',
        '옮기지 말 것: 소스, 테스트, 문서, 설정처럼 결과물인 것. 확신이 없으면 옮기지 마라.',
        'git 이 추적하는 파일과 git 이 무시하는 파일(빌드 결과, 캐시)은 두레가 옮기지 않고 이유를 알려준다.',
      ].join(' '),
      inputSchema: {
        paths: z.array(z.string()).min(1).max(200).describe('작업 폴더 기준의 경로들'),
        reason: z.string().describe('왜 최종 산출물이 아닌지 한 줄로'),
      },
    },
    async ({ paths, reason }) => {
      try {
        const r = await deps.cleanup.stash(ctx.workspace.id, paths, reason);
        return text({ moved: r.moved.map((i) => i.path), skipped: r.skipped });
      } catch (e) {
        return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
      }
    },
  );

  server.registerTool(
    'cleanup_list',
    { description: '이 프로젝트의 "정리 대기" 에 있는 것을 본다 (어느 워크스페이스가 무엇을 왜 옮겼는지).', inputSchema: {} },
    async () => text(deps.cleanup.list(ctx.project.id).map((i) => ({ workspace: i.workspaceName, path: i.path, reason: i.reason, size: i.size }))),
  );
};
