import type { DeliveryState } from '@shared/types';
import { formatDelivery, type MessageService } from './messages';
import type { WorkspaceStore } from './stores';
import { pendingMessage, type TodoService } from './todos';

/** 전달 엔진이 에이전트에게 실제로 손을 대는 방법. WorkspaceService 가 구현한다. */
export interface DeliveryActions {
  /** 응답을 끝냈다는 hook 으로 쉬는 중임이 확인됐는가 */
  isConfirmedIdle(workspaceId: string): boolean;
  /** 쉬는 에이전트의 터미널에 글을 써 넣어 깨운다 */
  wake(workspaceId: string, text: string): Promise<void>;
  /** 꺼진 에이전트를 이 글을 첫 프롬프트로 띄운다 */
  start(workspaceId: string, initialPrompt: string): Promise<void>;
}

interface Taken { text: string; messageIds: string[]; todoLines: string[] }

/**
 * 에이전트에게 전달할 것(사용자의 TODO 변경, 다른 워크스페이스의 메시지)을 언제 어떻게 전달할지 정한다.
 *
 * 원칙: 터미널에 써 넣는 것은 쉬는 중임이 확인됐을 때만 한다. 상태를 모르면 쓰지 않고 붙잡아 둔다.
 * 에이전트는 예고 없이 선택 창을 띄우고, 거기에 글이 들어가면 의도하지 않은 동작이 실행된다.
 */
export class DeliveryService {
  constructor(private readonly d: {
    workspaces: WorkspaceStore;
    todos: TodoService;
    messages: MessageService;
    actions: DeliveryActions;
  }) {}

  private take(workspaceId: string, o: { todos: boolean }): Taken | undefined {
    const todoLines = o.todos ? this.d.todos.takePending(workspaceId) : [];
    const messages = this.d.messages.undelivered(workspaceId);
    if (todoLines.length === 0 && messages.length === 0) return undefined;
    const parts: string[] = [];
    if (todoLines.length > 0) parts.push(pendingMessage(todoLines));
    for (const m of messages) {
      const fromName = m.from.kind === 'user' ? '사용자' : (this.d.workspaces.get(m.from.workspaceId)?.name ?? '지워진 워크스페이스');
      const artifacts = m.artifactIds.map((id) => this.d.messages.artifact(id)).filter((a) => a !== undefined);
      parts.push(formatDelivery(m, { fromName, artifacts }));
    }
    const messageIds = messages.map((m) => m.id);
    this.d.messages.markDelivered(messageIds);
    return { text: parts.join('\n\n'), messageIds, todoLines };
  }

  private giveBack(workspaceId: string, taken: Taken): void {
    this.d.messages.unmarkDelivered(taken.messageIds);
    this.d.todos.restorePending(workspaceId, taken.todoLines);
  }

  /** 전달할 글을 모아 돌려주고 전달된 것으로 표시한다. 없으면 undefined. hook 과 도구가 쓴다. */
  collect(workspaceId: string): string | undefined {
    return this.take(workspaceId, { todos: true })?.text;
  }

  /** 메시지만 모은다. TODO 는 이미 다른 방식으로 알려준 경우에 쓴다. */
  collectMessages(workspaceId: string): string | undefined {
    return this.take(workspaceId, { todos: false })?.text;
  }

  state(workspaceId: string): DeliveryState {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) return 'none';
    const ready = this.d.todos.pendingCount(workspaceId) + this.d.messages.undelivered(workspaceId).length;
    if (ready === 0) return this.d.messages.heldCount(workspaceId) > 0 ? 'held' : 'none';
    // 꺼진 에이전트에게 TODO 변경만 있을 때는 띄우지 않는다: 새 대화는 목록을 직접 읽는다.
    if (ws.status === 'stopped') return this.d.messages.undelivered(workspaceId).length > 0 ? 'starting' : 'none';
    if (ws.agentKind === 'codex') return 'waiting-codex';
    if (ws.status === 'working') return 'next-hook';
    if (ws.status === 'idle' && this.d.actions.isConfirmedIdle(workspaceId)) return 'waking';
    return 'waiting-unknown';
  }

  /** 새 메시지가 왔을 때, 멈춤이 풀렸을 때, 사용자가 "지금 알리기" 를 눌렀을 때 부른다. */
  async kick(workspaceId: string): Promise<DeliveryState> {
    const state = this.state(workspaceId);
    if (state !== 'waking' && state !== 'starting') return state;
    // 꺼진 에이전트에게는 메시지만 준다. TODO 는 띄운 뒤 SessionStart 때 목록 전체가 들어간다.
    const taken = this.take(workspaceId, { todos: state === 'waking' });
    if (!taken) return 'none';
    try {
      if (state === 'waking') await this.d.actions.wake(workspaceId, taken.text);
      else await this.d.actions.start(workspaceId, taken.text);
    } catch (e) {
      this.giveBack(workspaceId, taken); // 닿지 못한 것은 사라지면 안 된다
      throw e;
    }
    return state;
  }
}
