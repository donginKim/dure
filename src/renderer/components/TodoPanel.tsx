import { useState } from 'react';
import type { Todo, Workspace } from '@shared/types';
import { progress, TODO_STATUS_LABEL } from '../todoView';

export interface PendingInfo { count: number; canNudge: boolean }

function TodoRow({ todo, first, last, onError }: { todo: Todo; first: boolean; last: boolean; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);
  const run = (p: Promise<unknown>): void => { p.catch((e: Error) => onError(e.message)); };
  const save = (): void => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== todo.title) run(window.dure.todos.update(todo.id, { title }));
    else setDraft(todo.title);
  };
  const done = todo.status === 'done';
  const cancelled = todo.status === 'cancelled';

  return (
    <div className={`todo-row ${todo.status}`}>
      <input
        type="checkbox"
        checked={done}
        disabled={cancelled}
        title={done ? '완료 취소' : '완료로 표시'}
        onChange={(e) => run(window.dure.todos.update(todo.id, { status: e.target.checked ? 'done' : 'todo' }))}
      />
      <div className="todo-main">
        {editing ? (
          <input
            type="text"
            className="todo-edit"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { setDraft(todo.title); setEditing(false); }
            }}
          />
        ) : (
          <div className="todo-title" title="눌러서 고치기" onClick={() => { setDraft(todo.title); setEditing(true); }}>{todo.title}</div>
        )}
        {todo.detail && <div className="todo-detail" title={todo.detail}>{todo.detail}</div>}
      </div>
      {todo.status === 'doing' && <span className="todo-doing"><span className="spin" />{TODO_STATUS_LABEL.doing}</span>}
      {cancelled && <span className="tag">{TODO_STATUS_LABEL.cancelled}</span>}
      <div className="todo-actions">
        <button className="icon" title="위로" disabled={first} onClick={() => run(window.dure.todos.move(todo.id, 'up'))}>↑</button>
        <button className="icon" title="아래로" disabled={last} onClick={() => run(window.dure.todos.move(todo.id, 'down'))}>↓</button>
        <button
          className="icon"
          title={todo.assignee === 'user' ? '에이전트에게 맡기기' : '내가 할 일로 바꾸기'}
          onClick={() => run(window.dure.todos.update(todo.id, { assignee: todo.assignee === 'user' ? 'agent' : 'user' }))}
        >{todo.assignee === 'user' ? '에이전트' : '내 몫'}</button>
        <button
          className="icon"
          title={cancelled ? '되살리기' : '취소로 표시'}
          onClick={() => run(window.dure.todos.update(todo.id, { status: cancelled ? 'todo' : 'cancelled' }))}
        >{cancelled ? '되살림' : '취소'}</button>
        <button className="icon danger" title="삭제" onClick={() => run(window.dure.todos.remove(todo.id))}>삭제</button>
      </div>
    </div>
  );
}

/** 한 범위(워크스페이스 하나 또는 프로젝트)의 항목들과 추가 입력칸. */
export function TodoList({ projectId, workspaceId, items }: { projectId: string; workspaceId: string | null; items: Todo[] }) {
  const [title, setTitle] = useState('');
  const [mine, setMine] = useState(false);
  const [error, setError] = useState('');
  const agentItems = items.filter((t) => t.assignee === 'agent');
  const userItems = items.filter((t) => t.assignee === 'user');
  // 위·아래 버튼은 같은 범위 전체에서의 처음과 끝을 기준으로 끈다.
  const firstId = items[0]?.id;
  const lastId = items[items.length - 1]?.id;

  const add = async (): Promise<void> => {
    if (!title.trim()) return;
    try {
      await window.dure.todos.add({ projectId, workspaceId, title, assignee: mine ? 'user' : 'agent' });
      setTitle('');
      setMine(false); // 다음 항목이 실수로 내 몫이 되지 않게
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const row = (t: Todo) => <TodoRow key={t.id} todo={t} first={t.id === firstId} last={t.id === lastId} onError={setError} />;

  return (
    <div className="todo-list">
      {error && <div className="error" style={{ margin: '0 0 8px' }}>{error}</div>}
      {items.length === 0 && <div className="muted todo-none">항목이 없습니다.</div>}
      {agentItems.map(row)}
      {userItems.length > 0 && <div className="todo-sub">사용자 몫</div>}
      {userItems.map(row)}
      <form className="todo-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input type="text" value={title} placeholder="할 일 추가 후 Enter" onChange={(e) => setTitle(e.target.value)} />
        <label className="todo-mine" title="에이전트가 아니라 내가 할 일"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 내 몫</label>
      </form>
    </div>
  );
}

// 접힘 여부는 워크스페이스를 오가도 유지한다 (앱을 다시 켜면 펼침).
const collapsedState = new Map<string, boolean>();

/** 워크스페이스 화면 오른쪽의 TODO 패널. */
export function TodoPanel({ workspace, items, pending }: { workspace: Workspace; items: Todo[]; pending?: PendingInfo }) {
  const [collapsed, setCollapsedRaw] = useState(collapsedState.get(workspace.id) ?? false);
  const [error, setError] = useState('');
  const setCollapsed = (v: boolean): void => { collapsedState.set(workspace.id, v); setCollapsedRaw(v); };
  const { done, total } = progress(items);
  const label = total > 0 ? `${done}/${total}` : '';

  if (collapsed) {
    return (
      <button className="todo-tab" title="TODO 펼치기" onClick={() => setCollapsed(false)}>
        TODO {label}{pending && pending.count > 0 && workspace.status !== 'stopped' ? ` · 미전달 ${pending.count}` : ''}
      </button>
    );
  }

  return (
    <aside className="todo-panel">
      <div className="todo-head">
        <span className="t">TODO</span>
        {label && <span className="count">{label}</span>}
        <span className="spacer" />
        <button className="btn ghost" title="TODO 접기" onClick={() => setCollapsed(true)}>접기 ›</button>
      </div>
      {/* 꺼진 에이전트에게는 전달할 것이 없다: 새로 시작하면 목록을 직접 읽는다 */}
      {pending && pending.count > 0 && workspace.status !== 'stopped' && (
        <div className="todo-pending">
          <div>에이전트에게 아직 전달되지 않은 변경 {pending.count}건</div>
          {pending.canNudge ? (
            <button
              className="btn primary"
              onClick={() => { window.dure.todos.nudge(workspace.id).catch((e: Error) => setError(e.message)); }}
            >에이전트에게 알리기</button>
          ) : (
            <div className="muted">
              {workspace.agentKind === 'codex' ? '에이전트가 목록을 다시 읽을 때 전달됩니다'
                : workspace.status === 'idle' ? '다음 프롬프트 때 전달됩니다' : '다음 단계에 전달됩니다'}
            </div>
          )}
        </div>
      )}
      {error && <div className="error" style={{ margin: 10 }}>{error}</div>}
      <div className="todo-scroll">
        <TodoList projectId={workspace.projectId} workspaceId={workspace.id} items={items} />
      </div>
    </aside>
  );
}
