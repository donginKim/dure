import type { Project, Workspace, WorkspaceStatus } from '@shared/types';

/** 왼쪽 목록에서 무엇을 골랐는가. 이것이 지시 대상을 정한다. */
export type Selection =
  | { type: 'project'; id: string }
  | { type: 'workspace'; id: string; projectId?: string }
  | { type: 'settings' }
  | { type: 'people' }
  | { type: 'attention' }
  | null;

export interface TreeNode {
  project: Project;
  workspaces: Workspace[];
}

export const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  stopped: '꺼짐',
  starting: '시작 중',
  idle: '쉬는 중',
  working: '작업 중',
  waiting_user: '사용자 기다림',
};

/** 저장소 id → 그 저장소로 만든 워크스페이스 수 */
export function countByRepo(workspaces: Workspace[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of workspaces) counts[w.repoId] = (counts[w.repoId] ?? 0) + 1;
  return counts;
}

const byCreated = <T extends { createdAt: number }>(a: T, b: T): number => a.createdAt - b.createdAt;

export function buildTree(projects: Project[], workspaces: Workspace[]): TreeNode[] {
  return [...projects].sort(byCreated).map((project) => ({
    project,
    // 조율 에이전트는 목록에 보이지 않는다. 프로젝트 화면의 "조율" 탭에 있다.
    workspaces: workspaces.filter((w) => w.projectId === project.id && w.role !== 'coordinator').sort(byCreated),
  }));
}

/** 선택 대상이 사라졌으면 그 프로젝트로, 프로젝트도 없으면 null 로 옮긴다. */
export function reconcileSelection(sel: Selection, tree: TreeNode[]): Selection {
  if (!sel) return null;
  if (sel.type === 'settings' || sel.type === 'people' || sel.type === 'attention') return sel;
  if (sel.type === 'project') return tree.some((n) => n.project.id === sel.id) ? sel : null;
  const owner = tree.find((n) => n.workspaces.some((w) => w.id === sel.id));
  if (owner) return sel;
  return sel.projectId && tree.some((n) => n.project.id === sel.projectId) ? { type: 'project', id: sel.projectId } : null;
}
