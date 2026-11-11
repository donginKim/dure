import type { DeliveryState } from '@shared/types';
import { formatDelivery, type MessageService } from './messages';
import type { WorkspaceStore } from './stores';
import { pendingMessage, type TodoService } from './todos';

/** 전달 엔진이 에이전트에게 실제로 손을 대는 방법. WorkspaceService 가 구현한다. */
export interface DeliveryActions {
  /** 응답을 끝냈다는 hook 으로 쉬는 중임이 확인됐는가 */
  isConfirmedIdle(workspaceId: string): boolean;
  /** 지우는 중인가. 지우는 중에는 에이전트를 띄우거나 깨우지 않는다 */
  isRemoving(workspaceId: string): boolean;
  /** 마지막으로 에이전트의 신호(hook)를 받은 시각 */
  lastActivityAt(workspaceId: string): number | undefined;
  /** 쉬는 에이전트의 터미널에 글을 써 넣어 깨운다 */
  wake(workspaceId: string, text: string): Promise<void>;
  /** 꺼진 에이전트를 띄운다. 기다리던 메시지는 띄우는 쪽이 takeForStart 로 가져가 첫 프롬프트로 준다 */
  start(workspaceId: string): Promise<void>;
}

interface Taken { text: string; messageIds: string[]; todoLines: string[] }

/** 작업 중인데 이만큼 신호가 없으면 상태를 모르는 것으로 본다. 중단이나 모델 오류 뒤에는 hook 이 오지 않는다. */
const STALE_MS = 10 * 60_000;
/** 첫 프롬프트는 프로세스 인자로 들어간다. 너무 길면 인자로 주지 않고 도구로 읽게 한다. */
const MAX_FIRST_PROMPT = 30_000;

/**
 * 에이전트에게 전달할 것(사용자의 TODO 변경, 다른 워크스페이스의 메시지)을 언제 어떻게 전달할지 정한다.
 *
 * 원칙: 터미널에 써 넣는 것은 쉬는 중임이 확인됐을 때만 한다. 상태를 모르면 쓰지 않고 붙잡아 둔다.
 * 에이전트는 예고 없이 선택 창을 띄우고, 거기에 글이 들어가면 의도하지 않은 동작이 실행된다.
 */
export class DeliveryService {
  /** 첫 프롬프트로 건넸지만 에이전트가 받았다는 신호가 아직 없는 것 */
  private readonly awaitingStart = new Map<string, Taken>();
  /** 워크스페이스별 마지막 전달 실패 이유. 화면에 보여준다 */
  private readonly errors = new Map<string, string>();

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
      const fromName = m.from.kind === 'user' ? '사용자' : m.from.kind === 'system' ? '두레'
        : (this.d.workspaces.get(m.from.workspaceId)?.name ?? '지워진 워크스페이스');
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

  /**
   * 에이전트를 띄우는 쪽이 부른다. 기다리던 메시지를 첫 프롬프트로 쓸 글로 돌려준다.
   * 에이전트가 프롬프트를 받았다는 신호(confirmStart)가 오기 전에 끝나면 메시지를 되돌린다(agentExited).
   * Codex 는 첫 프롬프트 방식이 실측되지 않아 주지 않는다: 스스로 message_inbox 로 읽는다.
   */
  takeForStart(workspaceId: string): string | undefined {
    if (this.d.workspaces.get(workspaceId)?.agentKind !== 'claude') return undefined;
    const taken = this.take(workspaceId, { todos: false });
    if (!taken) return undefined;
    if (taken.text.length > MAX_FIRST_PROMPT) {
      const count = taken.messageIds.length;
      this.giveBack(workspaceId, taken);
      return `[두레] 다른 워크스페이스가 보낸 메시지가 ${count}건 있다. message_inbox 도구로 읽어라.`;
    }
    this.awaitingStart.set(workspaceId, taken);
    return taken.text;
  }

  /** 띄우려다 실패했다. 가져갔던 메시지를 되돌린다. */
  startFailed(workspaceId: string): void {
    const taken = this.awaitingStart.get(workspaceId);
    this.awaitingStart.delete(workspaceId);
    if (taken) this.giveBack(workspaceId, taken);
  }

  /** 에이전트가 프롬프트를 받았다 (UserPromptSubmit). 첫 프롬프트로 건넨 것은 이제 전달된 것이다. */
  confirmStart(workspaceId: string): void {
    this.awaitingStart.delete(workspaceId);
    this.errors.delete(workspaceId);
  }

  /** 에이전트 터미널이 끝났다. 첫 프롬프트를 받기 전이었다면 메시지를 되돌리고 이유를 남긴다. */
  agentExited(workspaceId: string): void {
    const taken = this.awaitingStart.get(workspaceId);
    if (!taken) return;
    this.awaitingStart.delete(workspaceId);
    this.giveBack(workspaceId, taken);
    // 다시 띄우지 않는다: 같은 이유로 또 끝나면 끝없이 반복된다. 사용자가 보고 직접 시작한다.
    this.errors.set(workspaceId, '에이전트가 메시지를 읽기 전에 종료됐습니다.');
  }

  /** 마지막 전달 실패 이유 */
  error(workspaceId: string): string | undefined {
    return this.errors.get(workspaceId);
  }

  /** 에이전트의 상태만 보고, 지금 무언가를 전달한다면 어떤 방식이 될지 */
  private route(workspaceId: string, now: number): DeliveryState {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || this.d.actions.isRemoving(workspaceId)) return 'none';
    if (ws.agentKind === 'codex') return 'waiting-codex';
    if (ws.status === 'stopped') return 'starting';
    if (ws.status === 'working') {
      const last = this.d.actions.lastActivityAt(workspaceId);
      return last !== undefined && now - last > STALE_MS ? 'waiting-unknown' : 'next-hook';
    }
    if (ws.status === 'idle' && this.d.actions.isConfirmedIdle(workspaceId)) return 'waking';
    return 'waiting-unknown';
  }

  /** 지금 이 워크스페이스에 새 메시지가 오면 어떻게 전달될지. 전달할 것이 없어도 답한다. */
  stateFor(workspaceId: string, now = Date.now()): DeliveryState {
    return this.route(workspaceId, now);
  }

  state(workspaceId: string, now = Date.now()): DeliveryState {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || this.d.actions.isRemoving(workspaceId)) return 'none';
    const messages = this.d.messages.undelivered(workspaceId).length;
    const ready = this.d.todos.pendingCount(workspaceId) + messages;
    if (ready === 0) return this.d.messages.heldCount(workspaceId) > 0 ? 'held' : 'none';
    // 꺼진 에이전트에게 TODO 변경만 있을 때는 띄우지 않는다: 새 대화는 목록을 직접 읽는다.
    if (ws.status === 'stopped' && messages === 0) return 'none';
    return this.route(workspaceId, now);
  }

  /** 새 메시지가 왔을 때, 멈춤이 풀렸을 때, 사용자가 "지금 알리기" 를 눌렀을 때 부른다. */
  async kick(workspaceId: string): Promise<DeliveryState> {
    const state = this.state(workspaceId);
    if (state === 'starting') {
      // 한 번 실패한 뒤에는 저절로 다시 띄우지 않는다. 사용자가 원인을 보고 직접 시작한다.
      if (this.errors.has(workspaceId)) return state;
      try {
        await this.d.actions.start(workspaceId);
      } catch (e) {
        this.errors.set(workspaceId, e instanceof Error ? e.message : String(e));
        throw e;
      }
      return state;
    }
    if (state !== 'waking') return state;
    const taken = this.take(workspaceId, { todos: true });
    if (!taken) return 'none';
    try {
      await this.d.actions.wake(workspaceId, taken.text);
      this.errors.delete(workspaceId);
    } catch (e) {
      this.giveBack(workspaceId, taken); // 닿지 못한 것은 사라지면 안 된다
      this.errors.set(workspaceId, e instanceof Error ? e.message : String(e));
      throw e;
    }
    return state;
  }

  /** 워크스페이스가 지워졌다 */
  forget(workspaceId: string): void {
    this.awaitingStart.delete(workspaceId);
    this.errors.delete(workspaceId);
  }
}
