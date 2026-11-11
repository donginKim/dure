import type { DeliveryInfo } from '@shared/ipc';
import { USER_RECIPIENT } from '@shared/messages';
import type { DeliveryState, Message, ProjectFlow, Thread, Workspace } from '@shared/types';

export const GONE = '지워진 워크스페이스';

export function workspaceName(id: string, workspaces: Workspace[]): string {
  // 에이전트가 사용자에게 남긴 말
  if (id === USER_RECIPIENT) return '나';
  return workspaces.find((w) => w.id === id)?.name ?? GONE;
}

export function senderName(m: Message, workspaces: Workspace[]): string {
  if (m.from.kind === 'user') return '사용자';
  if (m.from.kind === 'system') return '두레';
  return workspaceName(m.from.workspaceId, workspaces);
}

/** 그 워크스페이스가 보내거나 받은 스레드만, 최근 것이 먼저. */
export function threadsFor(threads: Thread[], messages: Record<string, Message[]>, workspaceId: string): Thread[] {
  return threads
    .filter((t) => (messages[t.id] ?? []).some((m) => m.toWorkspaceId === workspaceId || (m.from.kind === 'workspace' && m.from.workspaceId === workspaceId)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const DELIVERY_LABEL: Record<DeliveryState, string> = {
  none: '',
  'next-hook': '다음 단계에 전달',
  waking: '깨우는 중',
  starting: '에이전트를 띄우는 중',
  'waiting-start': '에이전트를 시작하면 전달됩니다 (메시지로 스스로 띄우지 않게 설정됨)',
  'waiting-unknown': '터미널 확인 필요: 에이전트가 무언가를 묻고 있을 수 있습니다',
  'waiting-codex': 'Codex 가 읽을 때까지 대기',
  held: '멈춰 있음',
};

export function deliveryLabel(state: DeliveryState): string {
  return DELIVERY_LABEL[state];
}

/** 사용자가 손을 써야 풀리는 상태인가 (화면에서 눈에 띄게 알린다) */
export function needsAttention(state: DeliveryState): boolean {
  return state === 'waiting-unknown' || state === 'waiting-codex' || state === 'waiting-start' || state === 'held';
}

/** 전달 대기 중인 것 옆에 보여줄 말과, 사용자가 손을 써야 하는지. 전달 실패가 있으면 그것이 먼저다. */
export function deliveryNote(info: DeliveryInfo): { text: string; attention: boolean } {
  if (info.error) return { text: `전달 실패: ${info.error}`, attention: true };
  return { text: deliveryLabel(info.state), attention: needsAttention(info.state) };
}

/** 스레드 위에 띄울 안내문. 상한이 멈춤보다, 프로젝트가 스레드보다 먼저다. */
export function threadNotice(t: Thread, flow: ProjectFlow): string | null {
  if (flow.capped) return '이 프로젝트에서 에이전트끼리 50번 주고받아 멈췄습니다. 내용을 확인하고 계속할지 정하세요.';
  if (t.capped) return '에이전트끼리 10번 주고받아 멈췄습니다. 내용을 확인하고 계속할지 정하세요.';
  if (flow.paused) return '프로젝트 전체가 멈춰 있습니다.';
  if (t.paused) return '이 대화는 멈춰 있습니다. 새 메시지는 재개할 때까지 전달되지 않습니다.';
  return null;
}

export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
