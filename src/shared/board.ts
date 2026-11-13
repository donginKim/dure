import type { AssignmentOut, BoardWork } from './types';

/** 다른 사람에게 나눠 준 워크스페이스 하나와 그 TODO (나눠 준 쪽에서 본 것) */
export interface RemoteWork {
  /** 화면에서 묶음을 가르는 키 */
  key: string;
  peerId: string; peerName: string;
  name: string; role: string; status: string;
  state: BoardWork['state'];
  /** status 가 unknown 이면 그 일이 어떻게 됐는지 모른다 (진행을 받지 못했거나, 그 사람이 제목을 바꿨거나 지웠다) */
  todos: { title: string; status: string; assignee: string; goal?: string }[];
}

/**
 * 내가 나눠 준 일을, 내가 보낸 워크스페이스와 TODO 를 기준으로 편다. 거절된 것은 뺀다.
 * - 이름과 맡을 일은 내가 보낸 것을 쓴다 (그 사람이 자기 PC 에서 바꾼 이름이 다른 사람에게 퍼지지 않는다).
 * - TODO 의 상태는 그 사람이 보내 준 진행에서 제목으로 찾는다. 수락 전이면 할 일, 찾지 못하면 unknown.
 *   같은 제목이 여러 번 와도 내가 보낸 TODO 하나로 센다. 그 사람이 새로 더한 TODO 는 세지 않는다.
 */
export function assignedWork(outgoing: AssignmentOut[]): RemoteWork[] {
  const out: RemoteWork[] = [];
  for (const a of outgoing) {
    if (a.state === 'declined') continue;
    const reported = new Map<string, string>();
    for (const w of a.progress) for (const t of w.todos) if (!reported.has(t.title)) reported.set(t.title, t.status);
    const state: BoardWork['state'] = a.state === 'sent' ? 'waiting' : a.progress.length > 0 ? 'active' : 'unknown';
    a.items.forEach((it, i) => {
      out.push({
        key: `${a.id}:${i}`, peerId: a.peerId, peerName: a.peerName, name: it.name, role: it.role, status: '', state,
        todos: it.todos.map((t) => ({ title: t.title, status: a.state === 'sent' ? 'todo' : reported.get(t.title) ?? 'unknown', assignee: t.assignee, ...(t.goal ? { goal: t.goal } : {}) })),
      });
    });
  }
  return out;
}

/**
 * 내가 나눠 준 일을, 그 사람이 보내 준 진행 그대로 편다 (나눠 준 사람의 화면에만 쓴다: 그 사람의 워크스페이스 이름과 TODO 가 보인다).
 * 진행을 받지 못한 것은 내가 보낸 그대로 보인다. 어느 프로젝트 TODO 에 딸렸는지(goal)는 내가 보낸 TODO 의 제목으로 찾는다.
 */
export function remoteWork(outgoing: AssignmentOut[]): RemoteWork[] {
  const out: RemoteWork[] = [];
  for (const a of outgoing) {
    if (a.state === 'declined') continue;
    if (a.state !== 'accepted' || a.progress.length === 0) { out.push(...assignedWork([a])); continue; }
    const goalOf = new Map<string, string>();
    for (const it of a.items) for (const t of it.todos) if (t.goal && !goalOf.has(t.title)) goalOf.set(t.title, t.goal);
    for (const w of a.progress) {
      out.push({
        key: `${a.id}:${w.workspaceId}`, peerId: a.peerId, peerName: a.peerName, name: w.name, role: w.summary, status: w.status, state: 'active',
        todos: w.todos.map((t) => ({ title: t.title, status: t.status, assignee: t.assignee, ...(goalOf.has(t.title) ? { goal: goalOf.get(t.title) } : {}) })),
      });
    }
  }
  return out;
}

/** 취소한 것은 빼고 센다. 어떻게 됐는지 모르는 것(unknown)은 끝나지 않은 것으로 센다. */
export function countDone(items: { status: string }[]): { done: number; total: number } {
  const counted = items.filter((t) => t.status !== 'cancelled');
  return { done: counted.filter((t) => t.status === 'done').length, total: counted.length };
}
