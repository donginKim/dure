import { useState, type ReactNode } from 'react';
import type { Todo, Workspace } from '@shared/types';
import { childrenOf, progress, TODO_STATUS_LABEL } from '../todoView';

/** 항목들 사이의 이음을 그리는 데 쓰는 것: 프로젝트 전체의 항목과 워크스페이스 */
export interface TodoLinks { all: Todo[]; workspaces: Workspace[] }

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

function StatusMark({ todo, onToggle, readOnly }: { todo: Todo; onToggle: () => void; readOnly?: boolean }) {
  const label = todo.status === 'done' ? '완료 취소' : todo.status === 'cancelled' ? '취소된 항목' : '완료로 표시';
  return (
    <button
      className={`mark ${todo.status}`}
      role="checkbox"
      aria-checked={todo.status === 'done'}
      aria-label={label}
      title={label}
      disabled={todo.status === 'cancelled' || readOnly}
      onClick={onToggle}
    >
      {todo.status === 'done' && <Icon name="check" />}
    </button>
  );
}

function TodoRow({ todo, first, last, onError, readOnly, links }: { todo: Todo; first: boolean; last: boolean; onError: (m: string) => void; readOnly?: boolean; links?: TodoLinks }) {
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
  // 프로젝트 항목: 딸린 워크스페이스 항목들. 워크스페이스 항목: 딸릴 수 있는 프로젝트 항목들.
  const kids = links && todo.workspaceId === null ? childrenOf(todo.id, links.all, links.workspaces) : [];
  const parents = links && todo.workspaceId !== null ? links.all.filter((t) => t.workspaceId === null) : [];
  const parent = todo.parentId ? parents.find((t) => t.id === todo.parentId) : undefined;
  const kidsDone = progress(kids.map((k) => k.todo));

  return (
    <>
    <div className={`todo-row ${todo.status}`}>
      <StatusMark todo={todo} readOnly={readOnly || kids.length > 0} onToggle={() => run(window.dure.todos.update(todo.id, { status: done ? 'todo' : 'done' }))} />
      <div className="todo-main">
        {editing && !readOnly ? (
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
          <div className="todo-title" title={readOnly ? undefined : '눌러서 고치기'} onClick={() => { if (!readOnly) { setDraft(todo.title); setEditing(true); } }}>{todo.title}</div>
        )}
        {todo.detail && <div className="todo-detail" title={todo.detail}>{todo.detail}</div>}
        {parent && <div className="todo-under" title={`프로젝트 항목 "${parent.title}" 에 딸린 일입니다. 딸린 일이 다 끝나면 그 항목이 완료됩니다`}>↳ {parent.title}</div>}
      </div>
      {kids.length > 0 && <span className="todo-count" title={`딸린 일 ${kidsDone.total}개 중 ${kidsDone.done}개 완료. 다 끝나면 이 항목이 저절로 완료됩니다`}>{kidsDone.done}/{kidsDone.total}</span>}
      {todo.status === 'doing' && <span className="todo-state">{TODO_STATUS_LABEL.doing}</span>}
      {cancelled && <span className="todo-state off">{TODO_STATUS_LABEL.cancelled}</span>}
      {!readOnly && <div className="todo-actions">
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
        {parents.length > 0 && (
          <select className="todo-parent" value={todo.parentId ?? ''} title="이 일이 딸린 프로젝트 항목. 딸린 일이 다 끝나면 그 항목이 완료됩니다" aria-label="딸린 프로젝트 항목" onChange={(e) => run(window.dure.todos.setParent(todo.id, e.target.value || null))}>
            <option value="">(딸린 곳 없음)</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <button className="icon danger" title="삭제" aria-label="삭제" onClick={() => run(window.dure.todos.remove(todo.id))}><Icon name="trash" /></button>
      </div>}
    </div>
    {kids.length > 0 && (
      <div className="todo-kids">
        {kids.map((k) => (
          <div key={k.todo.id} className={`todo-kid ${k.todo.status}`}>
            <span className={`tick ${k.todo.status}`} />
            <span className="todo-kid-ws">{k.workspace}</span>
            <span className="todo-kid-title">{k.todo.title}</span>
            {k.todo.status === 'doing' && <span className="todo-state">{TODO_STATUS_LABEL.doing}</span>}
          </div>
        ))}
      </div>
    )}
    </>
  );
}

/** 한 범위(워크스페이스 하나 또는 프로젝트)의 항목들과 추가 입력칸. */
export function TodoList({ projectId, workspaceId, items, readOnly, links }: {
  projectId: string; workspaceId: string | null; items: Todo[];
  /** 주면 프로젝트 항목 아래에 딸린 일을 보이고, 워크스페이스 항목을 프로젝트 항목에 달 수 있다 */
  links?: TodoLinks;
  /** 완료된 프로젝트: 보기만 한다 */
  readOnly?: boolean;
}) {
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
  const row = (t: Todo) => <TodoRow key={t.id} todo={t} first={t.id === firstId} last={t.id === lastId} onError={setError} readOnly={readOnly} links={links} />;

  return (
    <div className="todo-list">
      {error && <div className="error" style={{ margin: '0 0 8px' }}>{error}</div>}
      {agentItems.map(row)}
      {userItems.length > 0 && <div className="todo-sub"><span>내가 할 일</span><span className="n">{userItems.length}</span></div>}
      {userItems.map(row)}
      {readOnly && items.length === 0 && <div className="muted">할 일이 없습니다.</div>}
      {!readOnly && <form className={`todo-add${title ? ' typing' : ''}`} onSubmit={(e) => { e.preventDefault(); void add(); }}>
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
      </form>}
    </div>
  );
}

/** TODO 탭의 본문: 진행 눈금, 미전달 알림, 목록. */
export function TodoBody({ workspace, items, pending, readOnly, links }: { workspace: Workspace; items: Todo[]; pending?: PendingInfo; readOnly?: boolean; links?: TodoLinks }) {
  const [error, setError] = useState('');
  // 꺼진 에이전트에게는 전달할 것이 없다: 새로 시작하면 목록을 직접 읽는다
  const undelivered = pending && workspace.status !== 'stopped' ? pending.count : 0;
  return (
    <>
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
        <TodoList projectId={workspace.projectId} workspaceId={workspace.id} items={items} readOnly={readOnly} links={links} />
      </div>
    </>
  );
}
