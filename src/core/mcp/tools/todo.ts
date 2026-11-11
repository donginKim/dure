import { z } from 'zod';
import type { Todo } from '@shared/types';
import { TodoConflictError } from '../../todos';
import type { ToolBundle } from '../server';

const STATUS = z.enum(['todo', 'doing', 'done', 'cancelled']);
const ASSIGNEE = z.enum(['agent', 'user']);

/** 에이전트에게 보여주는 모양. rev 는 수정·삭제 때 그대로 돌려줘야 한다. */
const view = (t: Todo) => ({
  id: t.id, title: t.title, detail: t.detail, status: t.status, assignee: t.assignee, rev: t.rev,
  scope: t.workspaceId === null ? 'project' : 'workspace',
});

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** 에이전트가 두레의 TODO 를 읽고 쓰는 도구. 자기 워크스페이스의 항목만 고칠 수 있다. */
export const todoTools: ToolBundle = (server, ctx, deps) => {
  const todos = deps.todos;
  const mine = (id: string): Todo | undefined => {
    const t = todos.get(id);
    return t && t.workspaceId === ctx.workspace.id ? t : undefined;
  };
  // 사용자가 먼저 바꾼 항목이면 덮어쓰지 않고 현재 값을 알려준다.
  const guarded = (run: () => unknown) => {
    try {
      return ok(run());
    } catch (e) {
      if (e instanceof TodoConflictError) {
        return fail(`사용자가 이 항목을 먼저 바꿨다. 현재 값: ${JSON.stringify(view(e.current))}. todo_list 로 다시 읽고 판단하라.`);
      }
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

  server.registerTool(
    'todo_list',
    { description: '이 워크스페이스의 TODO 와 프로젝트 범위 TODO 를 읽는다. userChanges 는 사용자가 두레 화면에서 바꾼 내용 중 아직 전달되지 않은 것이다.' },
    async () => ok({
      items: [
        ...todos.listWorkspace(ctx.workspace.id),
        ...todos.listProject(ctx.project.id).filter((t) => t.workspaceId === null),
      ].map(view),
      userChanges: todos.takePending(ctx.workspace.id),
    }),
  );

  server.registerTool(
    'todo_add',
    {
      description: '이 워크스페이스의 TODO 에 항목을 더한다. 사용자가 해야 하는 일은 assignee 를 user 로 한다.',
      inputSchema: { title: z.string(), detail: z.string().optional(), assignee: ASSIGNEE.optional(), status: STATUS.optional() },
    },
    async (a) => guarded(() => view(todos.add({ projectId: ctx.project.id, workspaceId: ctx.workspace.id, ...a }, 'agent'))),
  );

  server.registerTool(
    'todo_update',
    {
      description: 'TODO 항목을 고친다. rev 는 todo_list 에서 읽은 값을 그대로 낸다.',
      inputSchema: {
        id: z.string(), rev: z.number().int(),
        title: z.string().optional(), detail: z.string().optional(), status: STATUS.optional(), assignee: ASSIGNEE.optional(),
      },
    },
    async ({ id, rev, ...patch }) => {
      if (!mine(id)) return fail('이 워크스페이스의 항목만 고칠 수 있다.');
      return guarded(() => view(todos.update(id, patch, { actor: 'agent', rev })));
    },
  );

  server.registerTool(
    'todo_remove',
    { description: 'TODO 항목을 지운다. rev 는 todo_list 에서 읽은 값을 그대로 낸다.', inputSchema: { id: z.string(), rev: z.number().int() } },
    async ({ id, rev }) => {
      if (!mine(id)) return fail('이 워크스페이스의 항목만 고칠 수 있다.');
      return guarded(() => { todos.remove(id, { actor: 'agent', rev }); return { removed: true }; });
    },
  );
};
