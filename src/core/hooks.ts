import type { Workspace, WorkspaceStatus } from '@shared/types';
import type { WorkspaceStore } from './stores';
import { pendingMessage, type TodoService } from './todos';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification';

export interface HookDeps {
  workspaces: WorkspaceStore;
  todos: TodoService;
  /** 워크스페이스 상태가 실제로 바뀌었을 때 불린다. */
  onStatus(workspaceId: string): void;
}

// 실험 10 (spikes/10-notification.mjs): 승인 창이 뜨면 notification_type 이 'permission_prompt' 로 온다.
function isPermissionPrompt(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null
    && (payload as { notification_type?: unknown }).notification_type === 'permission_prompt';
}

/**
 * 에이전트의 hook 호출을 처리한다.
 * 워크스페이스 상태를 갱신하고, hook 이 표준 출력으로 내보낼 글(JSON 또는 빈 글)을 돌려준다.
 * 사용자의 미전달 TODO 변경이 있으면 도구 실행 뒤, 프롬프트 제출 때, 응답 종료 때 끼워 넣는다.
 */
export function handleHook(deps: HookDeps, workspace: Workspace, event: string, payload: unknown): string {
  const setStatus = (next: WorkspaceStatus): void => {
    // 에이전트 터미널이 없는 워크스페이스가 뒤늦은 hook 으로 되살아나면 안 된다.
    if (workspace.status === 'stopped' || workspace.status === next) return;
    deps.workspaces.update(workspace.id, { status: next });
    deps.onStatus(workspace.id);
  };
  const pending = (): string | undefined => {
    const lines = deps.todos.takePending(workspace.id);
    return lines.length > 0 ? pendingMessage(lines) : undefined;
  };

  switch (event) {
    case 'SessionStart':
      setStatus('idle');
      return '';
    case 'PreToolUse':
      setStatus('working');
      return '';
    case 'UserPromptSubmit':
    case 'PostToolUse': {
      setStatus('working');
      const message = pending();
      return message ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: message } }) : '';
    }
    case 'Stop': {
      const message = pending();
      if (message) {
        // 끝내지 않고 이어서 반영하게 한다. 변경은 방금 가져갔으므로 다음 Stop 은 그냥 끝난다.
        setStatus('working');
        return JSON.stringify({ decision: 'block', reason: message });
      }
      setStatus('idle');
      return '';
    }
    case 'Notification':
      if (isPermissionPrompt(payload)) setStatus('waiting_user');
      return '';
    default:
      return '';
  }
}
