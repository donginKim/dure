import { z } from 'zod';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** 프로젝트 안에서 약속, 결정, 결과를 공유하는 자료 도구. 파일은 복사하지 않고 절대 경로로 가리킨다. */
export const artifactTools: ToolBundle = (server, ctx, deps) => {
  const { messages, workspaces } = deps;
  const by = (workspaceId: string | null): string => {
    if (!workspaceId) return '지워진 워크스페이스';
    // 다른 사람의 두레에서 받은 자료는 그렇다고 적는다.
    const remote = messages.remote(workspaceId);
    return remote ? `${remote.name}@${remote.owner} (다른 사람의 두레에서 받은 자료)` : workspaces.get(workspaceId)?.name ?? '지워진 워크스페이스';
  };

  server.registerTool(
    'artifact_publish',
    {
      description: 'API 형식 같은 약속, 결정, 작업 결과를 프로젝트의 자료로 올린다. 본문(body)을 적거나 파일의 절대 경로(path)를 적는다. 돌려받은 id 를 message_send 의 artifact_ids 에 붙일 수 있다.',
      inputSchema: {
        kind: z.enum(['result', 'decision', 'api-spec', 'note']),
        title: z.string(),
        body: z.string().optional(),
        path: z.string().optional().describe('파일의 절대 경로. 파일은 복사하지 않는다'),
      },
    },
    async ({ kind, title, body, path }) => {
      try {
        const a = messages.publish({ projectId: ctx.project.id, workspaceId: ctx.workspace.id, kind, title, body, path });
        return ok({ id: a.id, kind: a.kind, title: a.title, path: a.path });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'artifact_list',
    { description: '이 프로젝트에 올라온 자료 목록을 본다 (본문 제외).' },
    async () => ok({
      artifacts: messages.artifacts(ctx.project.id).map((a) => ({ id: a.id, kind: a.kind, title: a.title, path: a.path, by: by(a.workspaceId) })),
    }),
  );

  server.registerTool(
    'artifact_read',
    { description: '자료 하나의 본문을 읽는다.', inputSchema: { id: z.string() } },
    async ({ id }) => {
      const a = messages.artifact(id);
      if (!a || a.projectId !== ctx.project.id) return fail('이 프로젝트의 자료가 아니다.');
      return ok({ id: a.id, kind: a.kind, title: a.title, body: a.body, path: a.path, by: by(a.workspaceId) });
    },
  );
};
