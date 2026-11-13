import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { settled, waitingFor } from '@shared/todo';
import type { Actor, Todo, TodoAssignee, TodoPatch, TodoStatus } from '@shared/types';

export type { TodoPatch };

/** 에이전트가 낸 rev 가 현재와 다를 때. 사용자가 그사이 항목을 바꿨다는 뜻이다. */
export class TodoConflictError extends Error {
  constructor(readonly current: Todo) {
    super('사용자가 이 항목을 먼저 바꿨습니다.');
    this.name = 'TodoConflictError';
  }
}

/** 앞의 일이 끝나지 않아 에이전트가 시작하거나 완료할 수 없을 때. */
export class TodoWaitingError extends Error {
  constructor(readonly todo: Todo, readonly waiting: Todo[]) {
    super('앞의 일이 끝나지 않았습니다.');
    this.name = 'TodoWaitingError';
  }
}

/** 누가 바꾸는가. 에이전트는 자기가 마지막으로 읽은 rev 를 함께 낸다. */
export type By = { actor: 'user' } | { actor: 'agent'; rev: number };

/** 한 항목에 둘 수 있는 앞의 일의 수 */
const MAX_AFTER = 10;

interface Row {
  id: string; project_id: string; workspace_id: string | null; parent_id: string | null; title: string;
  /** 앞의 일의 id 들 (쉼표로 이은 것. 조회할 때 붙인다) */
  after?: string | null; detail: string; status: string;
  assignee: string; position: number; rev: number; updated_by: string; created_at: number; updated_at: number;
}

/** 항목을 읽는 문장의 앞부분: 앞의 일의 id 를 함께 가져온다 */
const SELECT = 'SELECT todos.*, (SELECT group_concat(after_id) FROM todo_deps WHERE todo_id = todos.id) AS after FROM todos';

const toTodo = (r: Row): Todo => ({
  id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, parentId: r.parent_id ?? null, after: r.after ? r.after.split(',') : [], title: r.title, detail: r.detail,
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

/**
 * 컨텍스트가 새로 시작되거나 압축된 에이전트에게 현재 TODO 를 다시 알려주는 글.
 * 남은 일은 제목까지, 끝난 일은 개수만 적는다. 항목이 하나도 없으면 undefined.
 */
export function todoDigest(workspaceItems: Todo[], projectItems: Todo[]): string | undefined {
  if (workspaceItems.length === 0 && projectItems.length === 0) return undefined;
  const open = (t: Todo): boolean => t.status === 'todo' || t.status === 'doing';
  const section = (title: string, items: Todo[]): string[] => (items.length > 0 ? [title, ...items.map((t) => `- ${t.title}`)] : []);
  const mine = workspaceItems.filter((t) => t.assignee === 'agent');
  const all = [...workspaceItems, ...projectItems];
  return [
    '[두레] 이 워크스페이스의 현재 TODO 다. 컨텍스트가 새로 시작되거나 압축돼서 다시 알려준다.',
    ...section('진행 중:', mine.filter((t) => t.status === 'doing')),
    ...section('할 일:', mine.filter((t) => t.status === 'todo')),
    ...section('사용자가 할 일:', workspaceItems.filter((t) => t.assignee === 'user' && open(t))),
    ...section('프로젝트 전체의 할 일 (읽기 전용):', projectItems.filter(open)),
    `완료 ${all.filter((t) => t.status === 'done').length}건, 취소 ${all.filter((t) => t.status === 'cancelled').length}건.`,
    '빠졌거나 사용자가 놓친 할 일이 보이면 todo_add 로 추가하라. 사용자가 해야 하는 일이면 assignee 를 user 로 한다. 항목을 고치기 전에는 todo_list 로 rev 를 읽어라.',
  ].join('\n');
}

/**
 * 딸린 항목들로 본 프로젝트 항목의 상태. 취소한 것은 빼고 본다.
 * 다 끝났으면 완료, 하나라도 시작됐으면 진행 중, 아니면 할 일. 딸린 것이 없으면 null (그대로 둔다).
 */
export function rollup(children: Pick<Todo, 'status'>[]): TodoStatus | null {
  const counted = children.filter((c) => c.status !== 'cancelled');
  if (counted.length === 0) return null;
  if (counted.every((c) => c.status === 'done')) return 'done';
  return counted.some((c) => c.status !== 'todo') ? 'doing' : 'todo';
}

function statusLine(status: TodoStatus, title: string): string {
  if (status === 'done') return `사용자가 직접 완료함: "${title}"`;
  if (status === 'cancelled') return `취소됨: "${title}"`;
  return `다시 열림: "${title}"`;
}

/**
 * TODO 의 원본. 사용자와 에이전트가 함께 고친다.
 * - 사용자 수정이 이긴다: 에이전트의 수정·삭제는 rev 가 맞아야 통과한다.
 * - 사용자가 워크스페이스 범위 항목을 바꾸면 그 워크스페이스의 "미전달 변경" 으로 쌓인다.
 * 이벤트: 'changed' (projectId), 'delivered' (workspaceId: 미전달 변경을 가져감),
 *   'unblocked' (todo, done: 앞의 일이 다 끝나 이제 시작할 수 있는 항목과, 방금 끝난 앞의 일)
 */
export class TodoService extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  private scope(projectId: string, workspaceId: string | null): Todo[] {
    const rows = workspaceId === null
      ? this.db.prepare(`${SELECT} WHERE project_id = ? AND workspace_id IS NULL ORDER BY position, rowid`).all(projectId)
      : this.db.prepare(`${SELECT} WHERE workspace_id = ? ORDER BY position, rowid`).all(workspaceId);
    return (rows as Row[]).map(toTodo);
  }

  listProject(projectId: string): Todo[] {
    return (this.db.prepare(`${SELECT} WHERE project_id = ? ORDER BY position, rowid`).all(projectId) as Row[]).map(toTodo);
  }

  listWorkspace(workspaceId: string): Todo[] {
    return (this.db.prepare(`${SELECT} WHERE workspace_id = ? ORDER BY position, rowid`).all(workspaceId) as Row[]).map(toTodo);
  }

  get(id: string): Todo | undefined {
    const r = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return r && toTodo(r);
  }

  private mustGet(id: string): Todo {
    const t = this.get(id);
    if (!t) throw new Error(`TODO 항목이 없습니다: ${id}`);
    return t;
  }

  // 사용자가 바꿨을 때만 쌓는다. 워크스페이스 범위 항목은 그 워크스페이스에, 프로젝트 범위 항목은 조율 에이전트에게 (있을 때).
  private notePending(todo: Pick<Todo, 'workspaceId' | 'projectId'>, actor: Actor, lines: string[]): void {
    if (actor !== 'user') return;
    const to = todo.workspaceId ?? (this.db.prepare("SELECT id FROM workspaces WHERE project_id = ? AND role = 'coordinator'").get(todo.projectId) as { id: string } | undefined)?.id;
    if (!to) return;
    const insert = this.db.prepare('INSERT INTO todo_pending (workspace_id, line) VALUES (?, ?)');
    for (const line of lines) insert.run(to, todo.workspaceId === null ? `(프로젝트 TODO) ${line}` : line);
  }

  /** 프로젝트 항목에 딸린 워크스페이스 항목들. */
  children(parentId: string): Todo[] {
    return (this.db.prepare(`${SELECT} WHERE parent_id = ? ORDER BY position, rowid`).all(parentId) as Row[]).map(toTodo);
  }

  /** 딸릴 수 있는 프로젝트 항목인지 본다: 같은 프로젝트의 프로젝트 범위 항목이어야 한다. */
  private checkParent(projectId: string, workspaceId: string | null, parentId: string): void {
    if (workspaceId === null) throw new Error('프로젝트 항목은 다른 항목 아래에 둘 수 없습니다.');
    const p = this.get(parentId);
    if (!p || p.projectId !== projectId || p.workspaceId !== null) throw new Error('그런 프로젝트 항목이 없습니다.');
  }

  /** 내 PC 밖에 있는 딸린 항목 (다른 사람에게 나눠 준 일). 배정 쪽이 알려 준다 */
  private extra: ((projectId: string, parentId: string) => { status: TodoStatus | 'unknown' }[]) | undefined;
  /** status 가 unknown 이면 그 일이 어떻게 됐는지 모른다 (그 사람이 진행을 보내지 않는다) */
  setExtraChildren(fn: (projectId: string, parentId: string) => { status: TodoStatus | 'unknown' }[]): void { this.extra = fn; }

  /** 딸린 항목이 바뀌었다: 프로젝트 항목의 상태를 맞춘다. 취소해 둔 프로젝트 항목은 건드리지 않는다. 바꿨으면 true */
  private settle(parentId: string | null): boolean {
    if (!parentId) return false;
    const p = this.get(parentId);
    if (!p || p.status === 'cancelled') return false;
    const far = this.extra?.(p.projectId, parentId) ?? [];
    const known = far.filter((t): t is { status: TodoStatus } => t.status !== 'unknown');
    let next = rollup([...this.children(parentId), ...known]);
    // 어떻게 됐는지 모르는 일이 있으면 저절로 완료하지 않는다. 이미 완료였으면 되돌리지도 않는다 (공개를 껐을 뿐일 수 있다).
    if (far.length > known.length && next === 'done') next = p.status === 'done' ? 'done' : 'doing';
    if (!next || next === p.status) return false;
    this.db.prepare("UPDATE todos SET status = ?, rev = rev + 1, updated_by = 'agent', updated_at = ? WHERE id = ?").run(next, Date.now(), parentId);
    return true;
  }

  /** 프로젝트 항목 전부를 딸린 항목에 맞춘다 (다른 사람에게 나눠 준 일의 진행이 바뀌었을 때). */
  settleProject(projectId: string): void {
    const ids = (this.db.prepare('SELECT id FROM todos WHERE project_id = ? AND workspace_id IS NULL').all(projectId) as { id: string }[]).map((r) => r.id);
    let changed = false;
    this.db.transaction(() => { for (const id of ids) changed = this.settle(id) || changed; })();
    if (changed) this.emit('changed', projectId);
  }

  /** 워크스페이스 항목을 프로젝트 항목 아래에 달거나 (parentId), 뗀다 (null). */
  setParent(id: string, parentId: string | null): Todo {
    const current = this.mustGet(id);
    if (parentId === current.parentId) return current;
    if (parentId !== null) this.checkParent(current.projectId, current.workspaceId, parentId);
    this.db.transaction(() => {
      this.db.prepare('UPDATE todos SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId, Date.now(), id);
      this.settle(current.parentId);
      this.settle(parentId);
    })();
    this.emit('changed', current.projectId);
    return this.mustGet(id);
  }

  // ---- 일의 순서 ----

  /** 이 항목이 끝나기를 기다리는 항목들. */
  private dependents(id: string): Todo[] {
    return (this.db.prepare(`${SELECT} WHERE id IN (SELECT todo_id FROM todo_deps WHERE after_id = ?)`).all(id) as Row[]).map(toTodo);
  }

  /** 앞의 일로 둘 수 있는지 본다: 같은 프로젝트의 워크스페이스 항목이어야 하고, 돌고 도는 순서가 되면 안 된다. */
  private checkAfter(todo: Pick<Todo, 'id' | 'projectId' | 'workspaceId'>, afterIds: string[]): void {
    if (afterIds.length === 0) return;
    if (todo.workspaceId === null) throw new Error('프로젝트 항목에는 앞의 일을 둘 수 없습니다 (프로젝트 항목은 딸린 일로 진행을 봅니다).');
    if (afterIds.length > MAX_AFTER) throw new Error(`앞의 일은 ${MAX_AFTER}개까지 둘 수 있습니다.`);
    for (const id of afterIds) {
      if (id === todo.id) throw new Error('자기 자신을 앞의 일로 둘 수 없습니다.');
      const a = this.get(id);
      if (!a || a.projectId !== todo.projectId || a.workspaceId === null) throw new Error('앞의 일로 둘 수 없는 항목입니다 (같은 프로젝트의 워크스페이스 항목만 됩니다).');
    }
    // 앞의 일을 거슬러 올라가다 이 항목이 나오면 돌고 도는 순서다: 아무도 시작할 수 없게 된다.
    const seen = new Set<string>();
    const stack = [...afterIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === todo.id) throw new Error('순서가 돌고 돕니다: 그 항목은 이미 이 항목이 끝나기를 기다립니다.');
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.db.prepare('SELECT after_id FROM todo_deps WHERE todo_id = ?').all(id) as { after_id: string }[]).map((r) => r.after_id));
    }
  }

  /** 앞의 일을 정한다 (전체를 바꾼다. 빈 목록이면 없앤다). */
  setAfter(id: string, afterIds: string[], actor: Actor = 'user'): Todo {
    const current = this.mustGet(id);
    const ids = [...new Set((Array.isArray(afterIds) ? afterIds : []).map(String))];
    this.checkAfter(current, ids);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM todo_deps WHERE todo_id = ?').run(id);
      const add = this.db.prepare('INSERT INTO todo_deps (todo_id, after_id) VALUES (?, ?)');
      for (const a of ids) add.run(id, a);
      this.db.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(Date.now(), id);
      const names = ids.map((a) => `"${this.get(a)?.title ?? ''}"`).join(', ');
      this.notePending(current, actor, [ids.length ? `순서 정해짐: "${current.title}" 은(는) ${names} 이(가) 끝난 뒤에 시작한다` : `순서 풀림: "${current.title}" 은(는) 이제 바로 시작할 수 있다`]);
    })();
    this.emit('changed', current.projectId);
    return this.mustGet(id);
  }

  /** 아직 끝나지 않은 앞의 일. */
  blockers(todo: Todo): Todo[] {
    return todo.after.length ? waitingFor(todo, this.listProject(todo.projectId)) : [];
  }

  /** 방금 끝난(또는 지워진) 항목을 기다리던 것 가운데, 이제 앞의 일이 다 끝난 것을 알린다. */
  private release(done: Todo, waiting: Todo[]): void {
    for (const w of waiting) {
      const now = this.get(w.id);
      if (now && !settled(now) && this.blockers(now).length === 0) this.emit('unblocked', now, done);
    }
  }

  private checkRev(current: Todo, by: By): void {
    if (by.actor === 'agent' && by.rev !== current.rev) throw new TodoConflictError(current);
  }

  add(
    i: { projectId: string; workspaceId?: string | null; title: string; detail?: string; assignee?: TodoAssignee; status?: TodoStatus; parentId?: string | null; after?: string[] },
    actor: Actor,
  ): Todo {
    const title = clean(i.title).trim();
    if (!title) throw new Error('제목을 입력하세요.');
    const workspaceId = i.workspaceId ?? null;
    const parentId = i.parentId ?? null;
    if (parentId !== null) this.checkParent(i.projectId, workspaceId, parentId);
    const siblings = this.scope(i.projectId, workspaceId);
    const position = siblings.length === 0 ? 1 : siblings[siblings.length - 1].position + 1;
    const now = Date.now();
    const id = crypto.randomUUID();
    const assignee = i.assignee ?? 'agent';
    const after = [...new Set(i.after ?? [])];
    this.checkAfter({ id, projectId: i.projectId, workspaceId }, after);
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO todos (id, project_id, workspace_id, parent_id, title, detail, status, assignee, position, rev, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(id, i.projectId, workspaceId, parentId, title, clean(i.detail ?? ''), i.status ?? 'todo', assignee, position, actor, now, now);
      const dep = this.db.prepare('INSERT INTO todo_deps (todo_id, after_id) VALUES (?, ?)');
      for (const a of after) dep.run(id, a);
      this.notePending({ workspaceId, projectId: i.projectId }, actor, [`추가됨: "${title}"${assignee === 'user' ? ' (사용자 몫)' : ''}`]);
      this.settle(parentId);
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
      // 일의 순서: 앞의 일이 끝나지 않았으면 에이전트는 시작하거나 완료할 수 없다. 사용자는 순서를 넘어설 수 있다.
      if (by.actor === 'agent' && (patch.status === 'doing' || patch.status === 'done')) {
        const wait = this.blockers(current);
        if (wait.length) throw new TodoWaitingError(current, wait);
      }
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
      if (next.status !== current.status) this.settle(current.parentId);
    })();
    this.emit('changed', current.projectId);
    // 끝났으면 이것을 기다리던 일에 알린다.
    if (!settled(current) && settled(next)) this.release(this.mustGet(id), this.dependents(id));
    return this.mustGet(id);
  }

  remove(id: string, by: By): void {
    const current = this.mustGet(id);
    this.checkRev(current, by);
    // 지워지면 이것을 기다리던 일은 더 기다릴 것이 없다.
    const waiting = settled(current) ? [] : this.dependents(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
      // 프로젝트 항목을 지우면 딸려 있던 항목은 남고, 어디에도 딸리지 않게 된다.
      this.db.prepare('UPDATE todos SET parent_id = NULL WHERE parent_id = ?').run(id);
      this.notePending(current, by.actor, [`삭제됨: "${current.title}"`]);
      this.settle(current.parentId);
    })();
    this.emit('changed', current.projectId);
    this.release(current, waiting);
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
