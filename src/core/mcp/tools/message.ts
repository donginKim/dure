import { z } from 'zod';
import type { DeliveryState, Message } from '@shared/types';
import type { ToolBundle } from '../server';

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** 보낸 쪽 에이전트에게, 받는 쪽에 어떻게 전달되는지 알려주는 말. */
const DELIVERY_TEXT: Record<DeliveryState, string> = {
  none: '전달됐다',
  'next-hook': '작업 중이라 다음 단계에 읽는다',
  waking: '쉬고 있어 깨웠다',
  starting: '꺼져 있어 띄웠다',
  'waiting-unknown': '상태를 확인할 수 없어 대기 중이다. 사용자가 그 워크스페이스를 봐야 할 수 있다',
  'waiting-codex': 'Codex 라 스스로 읽을 때까지 대기 중이다',
  held: '대화가 멈춰 있어 사용자가 재개하면 전달된다',
};

/** 같은 프로젝트의 다른 워크스페이스와 메시지를 주고받는 도구. */
export const messageTools: ToolBundle = (server, ctx, deps) => {
  const { messages, workspaces, delivery } = deps;
  const peers = () => workspaces.list(ctx.project.id);
  const nameOf = (id: string): string => workspaces.get(id)?.name ?? '지워진 워크스페이스';
  const senderName = (m: Message): string => (m.from.kind === 'user' ? '사용자' : nameOf(m.from.workspaceId));

  server.registerTool(
    'message_send',
    {
      description: '같은 프로젝트의 다른 워크스페이스 에이전트에게 메시지를 보낸다. 받은 에이전트는 스스로 깨어나 읽는다. 답장이면 thread_id 를 넣는다.',
      inputSchema: {
        to: z.string().describe('받는 워크스페이스의 이름 (project_overview 로 확인)'),
        body: z.string(),
        thread_id: z.string().optional(),
        artifact_ids: z.array(z.string()).optional(),
      },
    },
    async ({ to, body, thread_id, artifact_ids }) => {
      const names = peers().filter((w) => w.id !== ctx.workspace.id).map((w) => `"${w.name}"`).join(', ') || '(없음)';
      const matches = peers().filter((w) => w.name === to.trim());
      if (matches.length === 0) return fail(`"${to}" 라는 워크스페이스가 없다. 이 프로젝트의 다른 워크스페이스: ${names}`);
      if (matches.length > 1) return fail(`이름이 같은 워크스페이스가 둘 이상이라 받는 쪽을 정할 수 없다: "${to}". 사용자에게 이름을 바꿔 달라고 하라.`);
      try {
        // 보내기 전의 상태로 답한다: 보내는 순간 깨우거나 띄우면 상태가 바뀐다.
        const before = delivery.stateFor(matches[0].id);
        const m = messages.send({
          projectId: ctx.project.id, from: { kind: 'workspace', workspaceId: ctx.workspace.id },
          toWorkspaceId: matches[0].id, body, threadId: thread_id, artifactIds: artifact_ids,
        });
        // 멈춤이나 상한에 걸렸으면 저장만 되고 전달 대상에서 빠진다.
        const stored = messages.messages(m.threadId).find((x) => x.id === m.id);
        const held = stored?.deliveredAt === null && !messages.undelivered(matches[0].id).some((x) => x.id === m.id)
          && (before === 'next-hook' || before === 'waiting-unknown' || before === 'waiting-codex' || messages.heldCount(matches[0].id) > 0);
        return ok({ messageId: m.id, threadId: m.threadId, delivery: DELIVERY_TEXT[held ? 'held' : before] });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    'message_inbox',
    { description: '나에게 온 메시지 중 아직 읽지 않은 것을 가져온다. 가져가면 읽은 것으로 친다.' },
    async () => {
      const list = messages.undelivered(ctx.workspace.id);
      messages.markDelivered(list.map((m) => m.id));
      return ok({
        messages: list.map((m) => ({
          id: m.id, threadId: m.threadId, from: senderName(m), body: m.body,
          artifacts: m.artifactIds.map((id) => messages.artifact(id)).filter((a) => a !== undefined)
            .map((a) => ({ id: a.id, kind: a.kind, title: a.title, path: a.path })),
        })),
      });
    },
  );

  server.registerTool(
    'thread_read',
    { description: '내가 보내거나 받은 대화 스레드의 메시지 전체를 읽는다.', inputSchema: { thread_id: z.string() } },
    async ({ thread_id }) => {
      const thread = messages.thread(thread_id);
      const all = thread ? messages.messages(thread_id) : [];
      const involved = all.some((m) => m.toWorkspaceId === ctx.workspace.id || (m.from.kind === 'workspace' && m.from.workspaceId === ctx.workspace.id));
      if (!thread || thread.projectId !== ctx.project.id || !involved) return fail('내가 보내거나 받은 스레드가 아니다.');
      return ok({
        thread: { id: thread.id, title: thread.title },
        messages: all.map((m) => ({ from: senderName(m), to: nameOf(m.toWorkspaceId), body: m.body, at: new Date(m.createdAt).toISOString() })),
      });
    },
  );
};
