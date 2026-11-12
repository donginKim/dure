import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** 조율 에이전트만 쓰는 도구. 보통 워크스페이스의 에이전트에게는 보이지 않는다. */
export const coordinatorTools: ToolBundle = (server, ctx, deps) => {
  if (ctx.workspace.role !== 'coordinator') return;

  const TODO = z.object({
    title: z.string().describe('할 일 한 줄'),
    detail: z.string().optional().describe('필요하면 자세한 설명'),
    assignee: z.enum(['agent', 'user']).optional().describe('사용자가 해야 하는 일(결정, 커밋, 배포 등)이면 user. 기본은 agent'),
  });
  const WORK_TODO = TODO.extend({
    under: z.string().optional().describe('이 일이 딸린 프로젝트 TODO 의 제목 (project_todos 의 제목이나 이미 있는 프로젝트 TODO 의 제목과 글자까지 같게). 딸린 TODO 가 다 끝나면 그 프로젝트 TODO 가 저절로 완료된다'),
  });

  server.registerTool(
    'plan_propose',
    {
      description: [
        '기획서를 분석한 계획안을 사용자에게 올린다: 기획서 정리, 프로젝트 TODO(큰 일), 만들 워크스페이스, 워크스페이스마다의 TODO(프로젝트 TODO 에 딸린 실제 작업).',
        '함께하는 사람(project_overview 의 people)이 있으면, 누가 무엇을 맡을지 사용자와 대화로 정한 뒤에 올려라.',
        '이 도구는 아무것도 만들지 않는다. 사용자가 두레의 검토 화면에서 보고 고친 뒤 승인하면, 두레가 워크스페이스(작업 폴더와 브랜치)와 TODO 를 그대로 만든다.',
        '승인이나 거절은 두레가 [두레] 알림으로 알려 준다. 그때까지는 만들어진 것이 없으니 일을 시키지 말고 기다려라.',
        '저장소는 등록된 것을 쓴다 (project_overview 로 확인). 등록돼 있지 않지만 사용자의 PC 에 이미 있는 git 저장소 폴더가 맞으면 add_repos 에 그 절대 경로를 넣어라: 승인하면 두레가 그 폴더를 등록한다. 맞는 저장소가 어디에도 없으면 new_repos 에 새 저장소를 넣어라: 승인하면 두레가 빈 git 저장소를 만들어 등록한다. 저장소를 등록하는 다른 도구는 없다: 등록은 이 계획안으로 한다. 이름이 이미 있는 워크스페이스와 같으면 새로 만들지 않고 TODO 만 더한다. 다시 올리면 앞의 미결 계획안은 사라진다.',
      ].join(' '),
      inputSchema: {
        summary: z.string().describe('기획서를 정리한 글 (마크다운). 무엇을 만드는지, 범위와 범위 밖, 불확실해서 사용자가 정해야 하는 것'),
        new_repos: z.array(z.object({
          name: z.string().describe('새 저장소의 이름. 폴더 이름이 된다: 영문, 숫자, . _ - 만 (예: "shop-web")'),
          description: z.string().optional().describe('이 저장소에 무엇이 들어가는지 한두 줄. README 에 적힌다'),
        })).max(5).optional().describe('맞는 저장소가 등록돼 있지 않을 때 새로 만들 저장소. 승인하면 두레가 만든다 (README 와 첫 커밋, 브랜치 main)'),
        add_repos: z.array(z.object({
          path: z.string().describe('사용자의 PC 에 이미 있는 git 저장소 폴더의 절대 경로 (예: "/Users/me/Projects/shop-web")'),
        })).max(5).optional().describe('등록돼 있지 않지만 PC 에 이미 있는 저장소 폴더. 승인하면 두레가 이 프로젝트의 저장소로 등록한다 (폴더는 건드리지 않는다). 워크스페이스의 repo 에는 그 폴더의 이름이나 경로를 적는다'),
        workspaces: z.array(z.object({
          name: z.string().describe('워크스페이스 이름 (예: "로그인 화면")'),
          repo: z.string().optional().describe('등록된 저장소의 이름, add_repos 에 넣은 폴더의 이름이나 경로, 또는 new_repos 에 넣은 새 저장소의 이름. owner 를 준 워크스페이스에는 적지 않는다'),
          base_branch: z.string().optional().describe('기준 브랜치. 비우면 그 저장소의 현재 브랜치'),
          role: z.string().describe('이 워크스페이스가 맡을 일 (한두 줄)'),
          owner: z.string().optional().describe('이 일을 맡을 다른 사람의 이름 (project_overview 의 people). 주면 그 사람에게 나눠 준다: 그 사람이 자기 두레에서 수락해야 만들어지고, 저장소는 그 사람이 고른다 (repo 는 비워라). 비우면 내 사용자의 PC 에 만든다'),
          todos: z.array(WORK_TODO).max(40).describe('이 워크스페이스에 만들 TODO. 그 에이전트가 순서대로 할 수 있는 크기로 나눠라. 각 TODO 의 under 에 딸린 프로젝트 TODO 를 적어라'),
        })).max(20),
        project_todos: z.array(TODO).max(40).optional().describe('프로젝트에서 이뤄야 하는 큰 일의 목록. 워크스페이스의 TODO 가 under 로 여기에 딸린다. 워크스페이스가 할 수 없는 일(사용자의 결정 등)도 여기에 둔다: 사용자가 할 것은 assignee 를 user 로'),
        note: z.string().optional().describe('사용자에게 덧붙일 설명 (왜 이렇게 나눴는지)'),
      },
    },
    async (plan) => {
      try {
        const p = await deps.coordinator.propose(ctx.project.id, plan);
        const todos = p.items.reduce((n, i) => n + i.todos.length, 0) + p.projectTodos.length;
        return ok({ newRepos: p.newRepos.length, addRepos: p.addRepos.map((f) => f.path), workspaces: p.items.length, todos, status: '사용자의 검토와 승인을 기다린다. 결과는 두레가 알려 준다. 그때까지 아무것도 만들거나 시키지 말고 기다려라.' });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'todo_assign',
    {
      description: '이미 있는 워크스페이스의 TODO 에 항목 하나를 더한다 (계획안이 승인된 뒤에, 일하다 새로 생긴 할 일을 적을 때). 처음의 계획은 plan_propose 로 올려 사용자의 승인을 받아라. 프로젝트 전체의 일은 todo_add 를 써라.',
      inputSchema: {
        workspace: z.string().describe('워크스페이스 이름'),
        title: z.string(),
        detail: z.string().optional(),
        assignee: z.enum(['agent', 'user']).optional().describe('사용자가 해야 하는 일이면 user'),
        under: z.string().optional().describe('이 일이 딸린 프로젝트 TODO 의 제목이나 id (todo_list 의 items). 주면 그 프로젝트 TODO 의 진행에 함께 잡힌다'),
      },
    },
    async ({ workspace, title, detail, assignee, under }) => {
      const peers = deps.workspaces.list(ctx.project.id);
      const matches = peers.filter((w) => w.name === workspace.trim());
      if (matches.length === 0) return fail(`"${workspace}" 라는 워크스페이스가 없다. 있는 워크스페이스: ${peers.map((w) => `"${w.name}"`).join(', ') || '(없음. 먼저 plan_propose 로 계획안을 올려라)'}`);
      if (matches.length > 1) return fail(`이름이 같은 워크스페이스가 둘 이상이다: "${workspace}"`);
      const key = under?.trim();
      const projectItems = deps.todos.listProject(ctx.project.id).filter((t) => t.workspaceId === null);
      const parent = key ? projectItems.find((t) => t.id === key) ?? projectItems.find((t) => t.title === key) : undefined;
      if (key && !parent) return fail(`"${key}" 라는 프로젝트 TODO 가 없다. 있는 프로젝트 TODO: ${projectItems.map((t) => `"${t.title}"`).join(', ') || '(없음. todo_add 로 먼저 만들어라)'}`);
      try {
        const t = deps.todos.add({ projectId: ctx.project.id, workspaceId: matches[0]!.id, title, detail, assignee, parentId: parent?.id ?? null }, 'agent');
        return ok({ id: t.id, workspace: matches[0]!.name, title: t.title, ...(parent ? { under: parent.title } : {}) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
};
