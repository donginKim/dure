import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** 조율 에이전트만 쓰는 도구. 보통 워크스페이스의 에이전트에게는 보이지 않는다. */
export const coordinatorTools: ToolBundle = (server, ctx, deps) => {
  if (ctx.workspace.role !== 'coordinator') return;

  server.registerTool(
    'workspace_propose',
    {
      description: [
        '이 프로젝트에 필요한 워크스페이스를 사용자에게 제안한다. 사용자가 두레 화면에서 고치고 승인해야 만들어진다.',
        '승인이나 거절은 두레가 [두레] 알림으로 알려 준다. 그때까지는 만들어진 것이 없다.',
        '등록된 저장소만 대상으로 한다 (project_overview 로 확인). 새로 제안하면 앞의 미결 제안은 사라진다.',
      ].join(' '),
      inputSchema: {
        items: z.array(z.object({
          name: z.string().describe('워크스페이스 이름 (예: "로그인 화면")'),
          repo: z.string().describe('등록된 저장소의 이름'),
          base_branch: z.string().optional().describe('기준 브랜치. 비우면 그 저장소의 현재 브랜치'),
          role: z.string().describe('이 워크스페이스가 맡을 일 (한두 줄)'),
        })).min(1).max(20),
        note: z.string().optional().describe('사용자에게 덧붙일 설명 (왜 이렇게 나눴는지)'),
      },
    },
    async ({ items, note }) => {
      try {
        const p = await deps.coordinator.propose(ctx.project.id, items, note);
        return ok({ proposed: p.items.length, status: '사용자의 승인을 기다린다. 결과는 두레가 알려 준다. 그때까지 기다려라.' });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'todo_assign',
    {
      description: '특정 워크스페이스의 TODO 에 항목을 적는다 (그 워크스페이스의 에이전트와 사용자가 본다). 프로젝트 전체의 일은 todo_add 를 써라.',
      inputSchema: {
        workspace: z.string().describe('워크스페이스 이름'),
        title: z.string(),
        detail: z.string().optional(),
        assignee: z.enum(['agent', 'user']).optional().describe('사용자가 해야 하는 일이면 user'),
      },
    },
    async ({ workspace, title, detail, assignee }) => {
      const peers = deps.workspaces.list(ctx.project.id);
      const matches = peers.filter((w) => w.name === workspace.trim());
      if (matches.length === 0) return fail(`"${workspace}" 라는 워크스페이스가 없다. 있는 워크스페이스: ${peers.map((w) => `"${w.name}"`).join(', ') || '(없음. 먼저 workspace_propose 로 제안하라)'}`);
      if (matches.length > 1) return fail(`이름이 같은 워크스페이스가 둘 이상이다: "${workspace}"`);
      try {
        const t = deps.todos.add({ projectId: ctx.project.id, workspaceId: matches[0]!.id, title, detail, assignee }, 'agent');
        return ok({ id: t.id, workspace: matches[0]!.name, title: t.title });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
};
