import type { Project, Workspace, WorkspaceStatus } from '@shared/types';

/** 왼쪽 목록에서 무엇을 골랐는가. 이것이 지시 대상을 정한다. */
export type Selection =
  | { type: 'project'; id: string }
  | { type: 'workspace'; id: string; projectId?: string }
  | null;

export interface TreeNode {
  project: Project;
  workspaces: Workspace[];
}

export const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  stopped: '꺼짐',
  idle: '쉬는 중',
  working: '작업 중',
  waiting_user: '사용자 기다림',
};

const byCreated = <T extends { createdAt: number }>(a: T, b: T): number => a.createdAt - b.createdAt;

export function buildTree(projects: Project[], workspaces: Workspace[]): TreeNode[] {
  return [...projects].sort(byCreated).map((project) => ({
    project,
    workspaces: workspaces.filter((w) => w.projectId === project.id).sort(byCreated),
  }));
}

/** 선택 대상이 사라졌으면 그 프로젝트로, 프로젝트도 없으면 null 로 옮긴다. */
export function reconcileSelection(sel: Selection, tree: TreeNode[]): Selection {
  if (!sel) return null;
  if (sel.type === 'project') return tree.some((n) => n.project.id === sel.id) ? sel : null;
  const owner = tree.find((n) => n.workspaces.some((w) => w.id === sel.id));
  if (owner) return sel;
  return sel.projectId && tree.some((n) => n.project.id === sel.projectId) ? { type: 'project', id: sel.projectId } : null;
}
