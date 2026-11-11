import { useState, type ReactNode } from 'react';
import type { Todo, Workspace } from '@shared/types';
import { progress, TODO_STATUS_LABEL } from '../todoView';

export interface PendingInfo { count: number; canNudge: boolean }

// 선으로만 그린 작은 아이콘. 글자 버튼을 줄이기 위해 쓴다.
const ICONS: Record<string, ReactNode> = {
  up: <path d="M8 12.5V3.5M4 7.5l4-4 4 4" />,
  down: <path d="M8 3.5v9M4 8.5l4 4 4-4" />,
  person: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></>,
  agent: <><rect x="3" y="5" width="10" height="7.5" rx="2" /><path d="M8 5V2.8M6 8.6v1M10 8.6v1" /></>,
  cancel: <><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></>,
  restore: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 3.2v2.6h2.6" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  check: <path d="M4 8.4l2.7 2.7L12 5.6" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/** 항목 하나당 눈금 하나. 완료는 채워지고, 진행 중은 반쯤 차서 깜빡인다. 취소한 항목은 빼고 센다. */
export function Ticks({ items }: { items: Todo[] }) {
  const counted = items.filter((t) => t.status !== 'cancelled');
  if (counted.length === 0) return null;
  const { done, total } = progress(items);
  return (
    <div className="ticks" role="img" aria-label={`${total}개 중 ${done}개 완료`} title={`${total}개 중 ${done}개 완료`}>
      <div className="ticks-row">
        {counted.map((t) => <span key={t.id} className={`tick ${t.status}`} />)}
      </div>
      <span className="ticks-num">{done}<i>/</i>{total}</span>
    </div>
  );
}

function StatusMark({ todo, onToggle }: { todo: Todo; onToggle: () => void }) {
  const label = todo.status === 'done' ? '완료 취소' : todo.status === 'cancelled' ? '취소된 항목' : '완료로 표시';
  return (
    <button
      className={`mark ${todo.status}`}
      role="checkbox"
      aria-checked={todo.status === 'done'}
      aria-label={label}
      title={label}
      disabled={todo.status === 'cancelled'}
      onClick={onToggle}
    >
      {todo.status === 'done' && <Icon name="check" />}
    </button>
  );
}

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
      <StatusMark todo={todo} onToggle={() => run(window.dure.todos.update(todo.id, { status: done ? 'todo' : 'done' }))} />
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
      {todo.status === 'doing' && <span className="todo-state">{TODO_STATUS_LABEL.doing}</span>}
      {cancelled && <span className="todo-state off">{TODO_STATUS_LABEL.cancelled}</span>}
      <div className="todo-actions">
        <button className="icon" title="위로" aria-label="위로" disabled={first} onClick={() => run(window.dure.todos.move(todo.id, 'up'))}><Icon name="up" /></button>
        <button className="icon" title="아래로" aria-label="아래로" disabled={last} onClick={() => run(window.dure.todos.move(todo.id, 'down'))}><Icon name="down" /></button>
        <button
          className="icon"
          title={todo.assignee === 'user' ? '에이전트에게 맡기기' : '내가 할 일로 바꾸기'}
          aria-label={todo.assignee === 'user' ? '에이전트에게 맡기기' : '내가 할 일로 바꾸기'}
          onClick={() => run(window.dure.todos.update(todo.id, { assignee: todo.assignee === 'user' ? 'agent' : 'user' }))}
        ><Icon name={todo.assignee === 'user' ? 'agent' : 'person'} /></button>
        <button
          className="icon"
          title={cancelled ? '되살리기' : '하지 않기로 표시'}
          aria-label={cancelled ? '되살리기' : '하지 않기로 표시'}
          onClick={() => run(window.dure.todos.update(todo.id, { status: cancelled ? 'todo' : 'cancelled' }))}
        ><Icon name={cancelled ? 'restore' : 'cancel'} /></button>
        <button className="icon danger" title="삭제" aria-label="삭제" onClick={() => run(window.dure.todos.remove(todo.id))}><Icon name="trash" /></button>
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
      {agentItems.map(row)}
      {userItems.length > 0 && <div className="todo-sub"><span>내가 할 일</span><span className="n">{userItems.length}</span></div>}
      {userItems.map(row)}
      <form className={`todo-add${title ? ' typing' : ''}`} onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <span className="mark add"><Icon name="plus" /></span>
        <input
          type="text"
          value={title}
          aria-label="할 일 추가"
          placeholder={items.length === 0 ? '첫 할 일을 적고 Enter' : '할 일 추가'}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          type="button"
          className={`chip${mine ? ' on' : ''}`}
          aria-pressed={mine}
          title="켜면 에이전트가 아니라 내가 할 일로 추가됩니다"
          onClick={() => setMine((v) => !v)}
        ><Icon name="person" />내 몫</button>
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
  // 꺼진 에이전트에게는 전달할 것이 없다: 새로 시작하면 목록을 직접 읽는다
  const undelivered = pending && workspace.status !== 'stopped' ? pending.count : 0;

  if (collapsed) {
    return (
      <button className="todo-tab" title="TODO 펼치기" onClick={() => setCollapsed(false)}>
        TODO {label}{undelivered > 0 ? ` · 미전달 ${undelivered}` : ''}
      </button>
    );
  }

  return (
    <aside className="todo-panel">
      <div className="todo-head">
        <span className="t">TODO</span>
        <button className="btn ghost" title="TODO 접기" onClick={() => setCollapsed(true)}>접기</button>
      </div>
      <Ticks items={items} />
      {undelivered > 0 && pending && (
        <div className="todo-pending">
          <div className="grow">
            <div>에이전트가 아직 모르는 변경 {undelivered}건</div>
            {!pending.canNudge && (
              <div className="muted">
                {workspace.agentKind === 'codex' ? '에이전트가 목록을 다시 읽을 때 전달됩니다'
                  : workspace.status === 'idle' ? '다음 프롬프트 때 전달됩니다' : '다음 단계에 전달됩니다'}
              </div>
            )}
          </div>
          {pending.canNudge && (
            <button className="btn accent" onClick={() => { window.dure.todos.nudge(workspace.id).catch((e: Error) => setError(e.message)); }}>
              지금 알리기
            </button>
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
