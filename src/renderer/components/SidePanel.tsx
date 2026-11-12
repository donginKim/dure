import { useState } from 'react';
import type { Todo, Workspace } from '@shared/types';
import { deliveryNote, threadsFor } from '../conversationView';
import { progress } from '../todoView';
import { ConversationList, type ConversationData } from './ConversationPanel';
import { TodoBody, type PendingInfo } from './TodoPanel';

type Tab = 'todo' | 'talk';

// 접힘 여부와 고른 탭은 워크스페이스를 오가도 유지한다 (앱을 다시 켜면 처음 상태).
const remembered = new Map<string, { collapsed: boolean; tab: Tab }>();

/** 워크스페이스 화면 오른쪽 패널: TODO 와 대화를 탭으로 오간다. */
export function SidePanel({ workspace, workspaces, todos, projectTodos, pending, conversation, readOnly }: {
  /** 프로젝트 전체의 TODO: 이 워크스페이스의 일이 어느 프로젝트 항목에 딸렸는지 보이는 데 쓴다 */
  projectTodos?: Todo[];
  /** 완료된 프로젝트: TODO 를 보기만 한다 */
  readOnly?: boolean;
  workspace: Workspace; workspaces: Workspace[]; todos: Todo[]; pending?: PendingInfo; conversation: ConversationData;
}) {
  const [state, setStateRaw] = useState(remembered.get(workspace.id) ?? { collapsed: false, tab: 'todo' as Tab });
  const setState = (next: { collapsed: boolean; tab: Tab }): void => { remembered.set(workspace.id, next); setStateRaw(next); };
  const { done, total } = progress(todos);
  const threads = threadsFor(conversation.threads, conversation.messages, workspace.id);
  const info = conversation.delivery[workspace.id];
  // 사용자가 봐야 할 것이 있으면 탭에 점을 찍는다: 전달이 막혀 있거나, 낀 대화가 상한에 걸렸다.
  const attention = (info !== undefined && (info.waiting > 0 || info.held > 0 || info.error !== undefined) && deliveryNote(info).attention)
    || threads.some((t) => t.capped) || conversation.flow.capped;
  const todoLabel = total > 0 ? `${done}/${total}` : '';

  if (state.collapsed) {
    return (
      <button className="todo-tab" title="패널 펼치기" onClick={() => setState({ ...state, collapsed: false })}>
        TODO {todoLabel} · 대화 {threads.length}{attention ? ' ●' : ''}
      </button>
    );
  }

  return (
    <aside className="todo-panel">
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={state.tab === 'todo'} className={`side-tab${state.tab === 'todo' ? ' on' : ''}`} onClick={() => setState({ ...state, tab: 'todo' })}>
          TODO{todoLabel && <span className="n">{todoLabel}</span>}
        </button>
        <button role="tab" aria-selected={state.tab === 'talk'} className={`side-tab${state.tab === 'talk' ? ' on' : ''}`} onClick={() => setState({ ...state, tab: 'talk' })}>
          대화{threads.length > 0 && <span className="n">{threads.length}</span>}{attention && <span className="pip" title="확인이 필요한 대화가 있습니다" />}
        </button>
        <span className="spacer" />
        <button className="btn ghost" title="패널 접기" onClick={() => setState({ ...state, collapsed: true })}>접기</button>
      </div>
      {state.tab === 'todo'
        ? <TodoBody workspace={workspace} items={todos} pending={pending} readOnly={readOnly} links={projectTodos ? { all: projectTodos, workspaces } : undefined} />
        : (
          <div className="todo-scroll talk">
            <ConversationList
              projectId={workspace.projectId}
              threads={threads}
              data={conversation}
              workspaces={workspaces}
              empty="이 워크스페이스가 주고받은 대화가 없습니다. 에이전트가 다른 워크스페이스에 메시지를 보내면 여기에 보입니다."
            />
          </div>
        )}
    </aside>
  );
}
