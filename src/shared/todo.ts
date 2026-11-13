import type { Todo } from './types';

/** 끝난 것으로 치는 상태 (완료, 취소). 앞의 일이 이 상태면 뒤의 일을 시작할 수 있다. */
export const settled = (t: Pick<Todo, 'status'>): boolean => t.status === 'done' || t.status === 'cancelled';

/** 아직 끝나지 않은 앞의 일. all: 그 프로젝트의 항목 전체. 지워진 항목은 없는 것으로 본다. */
export function waitingFor(todo: Pick<Todo, 'after'>, all: Todo[]): Todo[] {
  if (todo.after.length === 0) return [];
  const byId = new Map(all.map((t) => [t.id, t]));
  return todo.after.map((id) => byId.get(id)).filter((t): t is Todo => t !== undefined && !settled(t));
}
