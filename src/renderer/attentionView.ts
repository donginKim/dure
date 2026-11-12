import type { AttentionItem } from '@shared/types';
import type { Selection } from './tree';

/** 그 항목을 처리하는 화면. 워크스페이스의 것은 그 워크스페이스, 프로젝트의 것은 프로젝트, 사람에 관한 것은 "사람". */
export function attentionTarget(i: Pick<AttentionItem, 'kind' | 'projectId' | 'workspaceId'>, coordinatorIds: Set<string>): Selection {
  if (i.kind === 'pair' || i.kind === 'invite') return { type: 'people' };
  // 조율 에이전트는 프로젝트 화면의 "조율" 탭에 있다.
  if (i.workspaceId && !coordinatorIds.has(i.workspaceId)) return { type: 'workspace', id: i.workspaceId, projectId: i.projectId ?? undefined };
  return i.projectId ? { type: 'project', id: i.projectId } : null;
}

/** 프로젝트마다 묶는다 (프로젝트가 없는 것은 맨 위 "사람" 묶음). 처음 나온 순서를 지킨다. */
export function groupAttention(items: AttentionItem[]): { projectId: string | null; projectName: string; items: AttentionItem[] }[] {
  const out: { projectId: string | null; projectName: string; items: AttentionItem[] }[] = [];
  for (const i of items) {
    let g = out.find((x) => x.projectId === i.projectId);
    if (!g) { g = { projectId: i.projectId, projectName: i.projectName, items: [] }; if (i.projectId === null) out.unshift(g); else out.push(g); }
    g.items.push(i);
  }
  return out;
}

/** 이 화면에서 바로 결정할 수 있는 종류 (그 프로젝트의 승인 카드를 그대로 보여 준다). */
export const INLINE_KINDS: AttentionItem['kind'][] = ['db', 'slack', 'browser', 'held'];
export const KIND_LABEL: Record<AttentionItem['kind'], string> = {
  agent: '에이전트', plan: '계획안', db: 'DB', slack: '슬랙', browser: '브라우저', held: '받은 메시지', assign: '받은 일', pair: '연결 요청', invite: '초대',
};
