import type { ToolBundle } from '../server';

/** 워크스페이스 자신에 관한 도구. */
export const workspaceTools: ToolBundle = (server, ctx, deps) => {
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

  // 워크스페이스는 저장소 하나만 보지만, 프로젝트에는 저장소가 여럿일 수 있다.
  // 에이전트가 같은 프로젝트의 다른 저장소와 워크스페이스를 폴더를 뒤지지 않고 알 수 있게 한다.
  server.registerTool(
    'project_overview',
    { description: '이 프로젝트에 등록된 모든 저장소와 워크스페이스(각각의 저장소, 브랜치, 작업 폴더, 상태)를 알려준다.' },
    async () => {
      const repos = deps.repos.list(ctx.project.id);
      const workspaces = deps.workspaces.listAll(ctx.project.id);
      const repoName = (id: string): string => repos.find((r) => r.id === id)?.name ?? '';
      const coordinator = ctx.workspace.role === 'coordinator';
      // 조율 에이전트는 워크스페이스를 제안하려면 저장소의 브랜치를 알아야 한다.
      const branches = coordinator ? await Promise.all(repos.map((r) => deps.git.listBranches(r.path).catch(() => [] as string[]))) : [];
      const current = coordinator ? await Promise.all(repos.map((r) => deps.git.currentBranch(r.path).catch(() => ''))) : [];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            project: { id: ctx.project.id, name: ctx.project.name },
            repos: repos.map((r, i) => ({
              name: r.name, path: r.path, workspaceCount: workspaces.filter((w) => w.repoId === r.id).length,
              ...(coordinator ? { currentBranch: current[i], branches: (branches[i] ?? []).slice(0, 50) } : {}),
            })),
            workspaces: workspaces.map((w) => (w.role === 'coordinator'
              ? { name: w.name, role: '조율 에이전트 (프로젝트 전체를 맡는다. 코드는 고치지 않는다)', status: w.status, isMe: w.id === ctx.workspace.id }
              : {
                name: w.name, repo: repoName(w.repoId), branch: w.branch, path: w.worktreePath,
                agent: w.agentKind, status: w.status, isMe: w.id === ctx.workspace.id, ...(w.summary ? { summary: w.summary } : {}),
              })),
          }),
        }],
      };
    },
  );
};
