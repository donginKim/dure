import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { Actor, Todo, TodoAssignee, TodoPatch, TodoStatus } from '@shared/types';

export type { TodoPatch };

/** 에이전트가 낸 rev 가 현재와 다를 때. 사용자가 그사이 항목을 바꿨다는 뜻이다. */
export class TodoConflictError extends Error {
  constructor(readonly current: Todo) {
    super('사용자가 이 항목을 먼저 바꿨습니다.');
    this.name = 'TodoConflictError';
  }
}

/** 누가 바꾸는가. 에이전트는 자기가 마지막으로 읽은 rev 를 함께 낸다. */
export type By = { actor: 'user' } | { actor: 'agent'; rev: number };

interface Row {
  id: string; project_id: string; workspace_id: string | null; title: string; detail: string; status: string;
  assignee: string; position: number; rev: number; updated_by: string; created_at: number; updated_at: number;
}

const toTodo = (r: Row): Todo => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, title: r.title, detail: r.detail,
  status: r.status as TodoStatus, assignee: r.assignee as TodoAssignee, position: r.position, rev: r.rev,
  updatedBy: r.updated_by as Actor, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** 에이전트에게 전달하는 글. 미전달 변경 여러 줄을 한 메시지로 묶는다. */
export function pendingMessage(lines: string[]): string {
  return [
    '[두레] 사용자가 TODO를 바꿨다. 다음 단계부터 반영하라:',
    ...lines.map((l) => `- ${l}`),
    '현재 목록은 todo_list 도구로 확인하라.',
  ].join('\n');
}

// 제목과 설명은 에이전트의 터미널에 써 넣어질 수 있다. 제어 문자가 섞이면 키 입력으로 해석되므로 저장하지 않는다.
// 줄바꿈만 남긴다.
// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');

function statusLine(status: TodoStatus, title: string): string {
  if (status === 'done') return `사용자가 직접 완료함: "${title}"`;
  if (status === 'cancelled') return `취소됨: "${title}"`;
  return `다시 열림: "${title}"`;
}

/**
 * TODO 의 원본. 사용자와 에이전트가 함께 고친다.
 * - 사용자 수정이 이긴다: 에이전트의 수정·삭제는 rev 가 맞아야 통과한다.
 * - 사용자가 워크스페이스 범위 항목을 바꾸면 그 워크스페이스의 "미전달 변경" 으로 쌓인다.
 * 이벤트: 'changed' (projectId), 'delivered' (workspaceId: 미전달 변경을 가져감)
 */
export class TodoService extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  private scope(projectId: string, workspaceId: string | null): Todo[] {
    const rows = workspaceId === null
      ? this.db.prepare('SELECT * FROM todos WHERE project_id = ? AND workspace_id IS NULL ORDER BY position, rowid').all(projectId)
      : this.db.prepare('SELECT * FROM todos WHERE workspace_id = ? ORDER BY position, rowid').all(workspaceId);
    return (rows as Row[]).map(toTodo);
  }

  listProject(projectId: string): Todo[] {
    return (this.db.prepare('SELECT * FROM todos WHERE project_id = ? ORDER BY position, rowid').all(projectId) as Row[]).map(toTodo);
  }

  listWorkspace(workspaceId: string): Todo[] {
    return (this.db.prepare('SELECT * FROM todos WHERE workspace_id = ? ORDER BY position, rowid').all(workspaceId) as Row[]).map(toTodo);
  }

  get(id: string): Todo | undefined {
    const r = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Row | undefined;
    return r && toTodo(r);
  }

  private mustGet(id: string): Todo {
    const t = this.get(id);
    if (!t) throw new Error(`TODO 항목이 없습니다: ${id}`);
    return t;
  }

  // 사용자가 워크스페이스 범위 항목을 바꿨을 때만 쌓는다.
  private notePending(todo: Pick<Todo, 'workspaceId'>, actor: Actor, lines: string[]): void {
    if (actor !== 'user' || todo.workspaceId === null) return;
    const insert = this.db.prepare('INSERT INTO todo_pending (workspace_id, line) VALUES (?, ?)');
    for (const line of lines) insert.run(todo.workspaceId, line);
  }

  private checkRev(current: Todo, by: By): void {
    if (by.actor === 'agent' && by.rev !== current.rev) throw new TodoConflictError(current);
  }

  add(
    i: { projectId: string; workspaceId?: string | null; title: string; detail?: string; assignee?: TodoAssignee; status?: TodoStatus },
    actor: Actor,
  ): Todo {
    const title = clean(i.title).trim();
    if (!title) throw new Error('제목을 입력하세요.');
    const workspaceId = i.workspaceId ?? null;
    const siblings = this.scope(i.projectId, workspaceId);
    const position = siblings.length === 0 ? 1 : siblings[siblings.length - 1].position + 1;
    const now = Date.now();
    const id = crypto.randomUUID();
    const assignee = i.assignee ?? 'agent';
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO todos (id, project_id, workspace_id, title, detail, status, assignee, position, rev, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, i.projectId, workspaceId, title, clean(i.detail ?? ''), i.status ?? 'todo', assignee, position, actor, now, now);
      this.notePending({ workspaceId }, actor, [`추가됨: "${title}"${assignee === 'user' ? ' (사용자 몫)' : ''}`]);
    })();
    this.emit('changed', i.projectId);
    return this.mustGet(id);
  }

  update(id: string, patch: TodoPatch, by: By): Todo {
    const current = this.mustGet(id);
    this.checkRev(current, by);
    const next = { ...current };
    const lines: string[] = [];
    if (patch.title !== undefined) {
      const title = clean(patch.title).trim();
      if (!title) throw new Error('제목을 입력하세요.');
      if (title !== current.title) { lines.push(`제목 바뀜: "${current.title}" → "${title}"`); next.title = title; }
    }
    if (patch.detail !== undefined && clean(patch.detail) !== current.detail) {
      lines.push(`설명 바뀜: "${next.title}"`);
      next.detail = clean(patch.detail);
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      lines.push(statusLine(patch.status, next.title));
      next.status = patch.status;
    }
    if (patch.assignee !== undefined && patch.assignee !== current.assignee) {
      lines.push(`담당 바뀜: "${next.title}" → ${patch.assignee === 'user' ? '사용자' : '에이전트'}`);
      next.assignee = patch.assignee;
    }
    if (lines.length === 0) return current; // 바뀐 것이 없다

    this.db.transaction(() => {
      this.db.prepare(
        'UPDATE todos SET title = ?, detail = ?, status = ?, assignee = ?, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?',
      ).run(next.title, next.detail, next.status, next.assignee, by.actor, Date.now(), id);
      this.notePending(current, by.actor, lines);
    })();
    this.emit('changed', current.projectId);
    return this.mustGet(id);
  }

  remove(id: string, by: By): void {
    const current = this.mustGet(id);
    this.checkRev(current, by);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
      this.notePending(current, by.actor, [`삭제됨: "${current.title}"`]);
    })();
    this.emit('changed', current.projectId);
  }

  /** 같은 범위의 이웃과 자리를 바꾼다. 사용자만 쓴다. */
  move(id: string, direction: 'up' | 'down'): void {
    const current = this.mustGet(id);
    const siblings = this.scope(current.projectId, current.workspaceId);
    const index = siblings.findIndex((t) => t.id === id);
    const other = siblings[direction === 'up' ? index - 1 : index + 1];
    if (!other) return;
    this.db.transaction(() => {
      const set = this.db.prepare('UPDATE todos SET position = ?, updated_at = ? WHERE id = ?');
      set.run(other.position, Date.now(), current.id);
      set.run(current.position, Date.now(), other.id);
      const newIndex = direction === 'up' ? index : index + 2;
      this.notePending(current, 'user', [`순서 바뀜: "${current.title}" 이(가) ${newIndex}번째로`]);
    })();
    this.emit('changed', current.projectId);
  }

  pendingCount(workspaceId: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM todo_pending WHERE workspace_id = ?').get(workspaceId) as { n: number }).n;
  }

  /** 미전달 변경을 돌려주고 전달된 것으로 지운다. */
  takePending(workspaceId: string): string[] {
    const lines = this.db.transaction(() => {
      const rows = this.db.prepare('SELECT line FROM todo_pending WHERE workspace_id = ? ORDER BY seq').all(workspaceId) as { line: string }[];
      this.db.prepare('DELETE FROM todo_pending WHERE workspace_id = ?').run(workspaceId);
      return rows.map((r) => r.line);
    })();
    // 화면의 "미전달 N건" 표시가 따라 바뀌어야 한다.
    if (lines.length > 0) this.emit('delivered', workspaceId);
    return lines;
  }

  /** 가져갔지만 에이전트에게 닿지 못한 줄을 다시 넣는다. */
  restorePending(workspaceId: string, lines: string[]): void {
    const insert = this.db.prepare('INSERT INTO todo_pending (workspace_id, line) VALUES (?, ?)');
    this.db.transaction(() => { for (const line of lines) insert.run(workspaceId, line); })();
    if (lines.length > 0) this.emit('delivered', workspaceId);
  }

  /** 워크스페이스의 항목과 미전달 변경을 모두 지운다. */
  removeWorkspace(workspaceId: string): void {
    const first = this.listWorkspace(workspaceId)[0];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM todo_pending WHERE workspace_id = ?').run(workspaceId);
      this.db.prepare('DELETE FROM todos WHERE workspace_id = ?').run(workspaceId);
    })();
    if (first) this.emit('changed', first.projectId);
  }
}
