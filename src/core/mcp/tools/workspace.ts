import type { ToolBundle } from '../server';

/** 워크스페이스 자신에 관한 도구. */
export const workspaceTools: ToolBundle = (server, ctx) => {
  server.registerTool(
    'workspace_whoami',
    { description: '이 에이전트가 속한 두레 워크스페이스와 프로젝트를 알려준다.' },
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          workspaceId: ctx.workspace.id,
          workspaceName: ctx.workspace.name,
          projectId: ctx.project.id,
          projectName: ctx.project.name,
          agentKind: ctx.workspace.agentKind,
        }),
      }],
    }),
  );
};
