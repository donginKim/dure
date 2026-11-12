import type { Todo, TodoStatus, Workspace } from '@shared/types';

export interface TodoGroup {
  key: string;
  title: string;
  /** null 이면 프로젝트 범위 묶음 */
  workspaceId: string | null;
  items: Todo[];
}

export const TODO_STATUS_LABEL: Record<TodoStatus, string> = { todo: '할 일', doing: '진행 중', done: '완료', cancelled: '취소' };

const byPosition = (a: Todo, b: Todo): number => a.position - b.position;

/** 프로젝트 묶음이 먼저, 이어서 워크스페이스를 만든 순서대로. 항목이 없는 워크스페이스도 묶음으로 나온다. */
export function groupTodos(todos: Todo[], workspaces: Workspace[]): TodoGroup[] {
  const ordered = [...workspaces].sort((a, b) => a.createdAt - b.createdAt);
  return [
    { key: 'project', title: '프로젝트', workspaceId: null, items: todos.filter((t) => t.workspaceId === null).sort(byPosition) },
    ...ordered.map((w) => ({ key: w.id, title: w.name, workspaceId: w.id, items: todos.filter((t) => t.workspaceId === w.id).sort(byPosition) })),
  ];
}

/** 취소한 항목은 셈에서 뺀다. */
export function progress(items: Todo[]): { done: number; total: number } {
  const counted = items.filter((t) => t.status !== 'cancelled');
  return { done: counted.filter((t) => t.status === 'done').length, total: counted.length };
}

/** 프로젝트 항목에 딸린 워크스페이스 항목들 (워크스페이스를 만든 순서, 그 안에서는 자리 순서). */
export function childrenOf(parentId: string, todos: Todo[], workspaces: Pick<Workspace, 'id' | 'name' | 'createdAt'>[]): { todo: Todo; workspace: string }[] {
  const order = new Map([...workspaces].sort((a, b) => a.createdAt - b.createdAt).map((w, i) => [w.id, { i, name: w.name }]));
  return todos
    .filter((t) => t.parentId === parentId && t.workspaceId !== null)
    .sort((a, b) => (order.get(a.workspaceId!)?.i ?? 1e9) - (order.get(b.workspaceId!)?.i ?? 1e9) || a.position - b.position)
    .map((t) => ({ todo: t, workspace: order.get(t.workspaceId!)?.name ?? '' }));
}
