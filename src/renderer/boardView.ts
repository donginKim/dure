import { remoteWork } from '@shared/board';
import type { AssignmentOut, Board, BoardWork, Todo, TodoStatus, Workspace } from '@shared/types';

/** 현황판을 받은 지 얼마나 됐는지. */
export function boardAge(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return '방금 받음';
  if (min < 60) return `${min}분 전 기준`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 전 기준` : `${Math.floor(h / 24)}일 전 기준`;
}

export function boardTotals(b: Pick<Board, 'goals'>): { goals: number; goalsDone: number } {
  return { goals: b.goals.length, goalsDone: b.goals.filter((g) => g.status === 'done').length };
}

/** 진행을 보일 수 없는 워크스페이스에 붙는 말. 진행이 보이면 빈 글 */
export function workStateLabel(w: Pick<BoardWork, 'state'>): string {
  return w.state === 'waiting' ? '수락을 기다리는 중' : w.state === 'unknown' ? '진행을 받지 못함' : '';
}

const STATUSES: TodoStatus[] = ['todo', 'doing', 'done', 'cancelled'];

/**
 * 다른 사람에게 나눠 준 일을 화면의 TODO 묶음으로: 워크스페이스처럼 생긴 묶음과 그 항목 (보기만 한다).
 * 묶음의 이름은 "워크스페이스@사람" 이다. 항목의 parentId 는 그것이 딸린 내 프로젝트 TODO 다.
 */
export function remoteGroups(projectId: string, outgoing: AssignmentOut[]): { workspaces: Pick<Workspace, 'id' | 'name' | 'createdAt'>[]; todos: Todo[]; notes: Record<string, string> } {
  const workspaces: Pick<Workspace, 'id' | 'name' | 'createdAt'>[] = [];
  const todos: Todo[] = [];
  const notes: Record<string, string> = {};
  remoteWork(outgoing).forEach((w, i) => {
    const id = `remote:${w.key}`;
    // 내 워크스페이스 뒤에 오게 한다.
    workspaces.push({ id, name: `${w.name}@${w.peerName}`, createdAt: Number.MAX_SAFE_INTEGER - 10_000 + i });
    const note = workStateLabel(w);
    if (note) notes[id] = note;
    w.todos.forEach((t, k) => {
      todos.push({
        id: `${id}:${k}`, projectId, workspaceId: id, parentId: t.goal ?? null, after: [], title: t.title, detail: '',
        status: STATUSES.includes(t.status as TodoStatus) ? t.status as TodoStatus : 'todo', assignee: t.assignee === 'user' ? 'user' : 'agent',
        position: k + 1, rev: 0, updatedBy: 'agent', createdAt: 0, updatedAt: 0,
      });
    });
  });
  return { workspaces, todos, notes };
}
