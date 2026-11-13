import type { AssignmentOut, BoardWork } from './types';

/** 다른 사람에게 나눠 준 워크스페이스 하나와 그 TODO (나눠 준 쪽에서 본 것) */
export interface RemoteWork {
  /** 화면에서 묶음을 가르는 키 */
  key: string;
  peerId: string; peerName: string;
  name: string; role: string; status: string;
  state: BoardWork['state'];
  todos: { title: string; status: string; assignee: string; goal?: string }[];
}

/**
 * 내가 나눠 준 일을 워크스페이스 단위로 편다. 거절된 것은 뺀다.
 * - 수락 전, 또는 수락했지만 진행을 받지 못한 것: 내가 보낸 그대로 (모두 할 일).
 * - 진행을 받은 것: 그 사람의 워크스페이스와 TODO. 어느 프로젝트 TODO 에 딸렸는지(goal)는 내가 보낸 TODO 의 제목으로 찾는다
 *   (그 사람이 제목을 바꾸거나 새로 더한 TODO 는 어디에도 딸리지 않는다).
 */
export function remoteWork(outgoing: AssignmentOut[]): RemoteWork[] {
  const out: RemoteWork[] = [];
  for (const a of outgoing) {
    if (a.state === 'declined') continue;
    if (a.state === 'accepted' && a.progress.length > 0) {
      const goalOf = new Map<string, string>();
      for (const it of a.items) for (const t of it.todos) if (t.goal && !goalOf.has(t.title)) goalOf.set(t.title, t.goal);
      for (const w of a.progress) {
        out.push({
          key: `${a.id}:${w.workspaceId}`, peerId: a.peerId, peerName: a.peerName, name: w.name, role: w.summary, status: w.status, state: 'active',
          todos: w.todos.map((t) => ({ title: t.title, status: t.status, assignee: t.assignee, ...(goalOf.has(t.title) ? { goal: goalOf.get(t.title) } : {}) })),
        });
      }
      continue;
    }
    a.items.forEach((it, i) => {
      out.push({
        key: `${a.id}:${i}`, peerId: a.peerId, peerName: a.peerName, name: it.name, role: it.role, status: '', state: a.state === 'sent' ? 'waiting' : 'unknown',
        todos: it.todos.map((t) => ({ title: t.title, status: 'todo', assignee: t.assignee, ...(t.goal ? { goal: t.goal } : {}) })),
      });
    });
  }
  return out;
}

/** 취소한 것은 빼고 센다. */
export function countDone(items: { status: string }[]): { done: number; total: number } {
  const counted = items.filter((t) => t.status !== 'cancelled');
  return { done: counted.filter((t) => t.status === 'done').length, total: counted.length };
}
