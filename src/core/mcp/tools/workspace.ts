import { z } from 'zod';
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

  // 조율 에이전트는 화면의 목록에 나오지 않는다: 요약과 이름이 없다.
  if (ctx.workspace.role !== 'coordinator') {
    server.registerTool(
      'workspace_describe',
      {
        description: [
          '이 워크스페이스가 지금 무엇을 하는지를 두레 화면에 알린다. 사용자는 왼쪽 목록에서 워크스페이스마다 이 한 줄을 보고 무슨 일이 진행 중인지 안다.',
          'summary: 지금 하는 일 한 줄 (80자까지). 일을 시작할 때, 하는 일이 바뀔 때, 끝났을 때 갱신하라.',
          'name: 워크스페이스의 표시 이름 (40자까지). 지금 이름이 작업 내용을 말해 주지 않을 때만 준다. 사용자가 직접 지은 이름은 바뀌지 않는다. 브랜치와 작업 폴더는 바뀌지 않는다.',
        ].join(' '),
        inputSchema: {
          summary: z.string().optional().describe('지금 하는 일 한 줄. 예: "로그인 폼 검증 붙이는 중", "API 완성, 커밋 대기"'),
          name: z.string().optional().describe('작업 내용을 말해 주는 짧은 이름. 예: "로그인 화면"'),
        },
      },
      async ({ summary, name }) => {
        try {
          return { content: [{ type: 'text' as const, text: JSON.stringify(deps.describe(ctx.workspace.id, { summary, name })) }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
      },
    );
  }

  // 워크스페이스는 저장소 하나만 보지만, 프로젝트에는 저장소가 여럿일 수 있다.
  // 에이전트가 같은 프로젝트의 다른 저장소와 워크스페이스를 폴더를 뒤지지 않고 알 수 있게 한다.
  server.registerTool(
    'project_overview',
    { description: '이 프로젝트에 등록된 모든 저장소와 워크스페이스(각각의 저장소, 브랜치, 작업 폴더, 상태)를 알려준다.' },
    async () => {
      const repos = deps.repos.list(ctx.project.id);
      const others = deps.peers.remoteWorkspaces(ctx.project.id);
      const people = deps.peers.people(ctx.project.id);
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
            // 조율 에이전트: 일을 나눠 줄 수 있는 사람 (plan_propose 의 owner 에 name 을 쓴다).
            ...(coordinator && people.length ? { people: people.map((p) => ({ name: p.name, online: p.online })) } : {}),
            // 다른 사람의 두레에 있는 워크스페이스 (함께하는 프로젝트에서 그 사람이 공개한 것). message_send 의 to 에 name 을 그대로 쓴다.
            ...(others.length ? { otherPeople: others.map((r) => ({ name: r.label, owner: r.peerName, note: '다른 사람의 에이전트다. 파일을 같이 쓰지 않는다: 필요한 내용은 메시지와 자료의 글로 주고받아라' })) } : {}),
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
