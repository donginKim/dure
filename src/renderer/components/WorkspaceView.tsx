import { useCallback, useEffect, useRef, useState } from 'react';
import { ERROR_PREFIX } from '@shared/ipc';
import type { Project, Repo, TerminalInfo, Todo, Workspace } from '@shared/types';
import { recallView, rememberView, type ViewMode } from '../chatView';
import { STATUS_LABEL, type Selection } from '../tree';
import { ChatPane } from './ChatPane';
import { CommitDialog } from './CommitDialog';
import { ConfirmDialog } from './dialogs';
import { TerminalPane } from './TerminalPane';
import type { ConversationData } from './ConversationPanel';
import { SidePanel } from './SidePanel';
import type { PendingInfo } from './TodoPanel';

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

/** 코어가 붙인 표시를 보고 사용자에게 보여줄 문장으로 바꾼다. */
export function describeError(message: string): string {
  if (message.startsWith(ERROR_PREFIX.agentNotInstalled)) {
    const kind = message.slice(ERROR_PREFIX.agentNotInstalled.length).split(':')[0];
    return `${kind === 'codex' ? 'Codex' : 'Claude Code'}가 설치돼 있지 않거나 PATH 에 없습니다.`;
  }
  if (message.startsWith(ERROR_PREFIX.worktreeMissing)) return '작업 폴더가 없습니다. 워크스페이스를 지우고 다시 만드세요.';
  return message;
}

export function WorkspaceView({ workspace, workspaces, project, repo, todos, pending, conversation, onSelect }: {
  workspace: Workspace; workspaces: Workspace[]; project?: Project; repo?: Repo; todos: Todo[]; pending?: PendingInfo;
  conversation: ConversationData; onSelect: (s: Selection) => void;
}) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<{ uncommitted: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const [committing, setCommitting] = useState(false);
  // 보기: 터미널 또는 채팅. 워크스페이스마다 기억한다. Codex 는 채팅 보기가 없다.
  const canChat = workspace.agentKind === 'claude';
  const [mode, setMode] = useState<ViewMode>(() => (canChat ? recallView(workspace.id, window.localStorage) : 'terminal'));
  const switchTo = (next: ViewMode): void => { setMode(next); rememberView(workspace.id, next, window.localStorage); };
  // 커밋 버튼에 보일 것: 바뀐 파일 수와 에이전트가 써 둔 초안이 있는지
  const [commitInfo, setCommitInfo] = useState<{ changed: number; hasDraft: boolean }>({ changed: 0, hasDraft: false });

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      window.dure.commit.state(workspace.id)
        .then((s) => { if (alive) setCommitInfo({ changed: s.files.length, hasDraft: s.draft !== null }); })
        .catch(() => undefined);
    };
    read();
    // 에이전트가 파일을 고치면 상태 신호가 온다. 그때 바뀐 파일 수를 다시 읽는다.
    const off = window.dure.onChanged((topic) => { if (topic === 'commit' || topic === 'workspaces') read(); });
    return () => { alive = false; off(); };
  }, [workspace.id]);

  const load = useCallback(async () => {
    const list = await window.dure.terminals.list(workspace.id);
    // 에이전트 터미널이 첫 탭이다.
    list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'agent' ? -1 : 1));
    setTerminals(list);
    setActiveId((cur) => (cur && list.some((t) => t.id === cur) ? cur : (list[0]?.id ?? null)));
  }, [workspace.id]);

  const askRemove = async (): Promise<void> => {
    // 에이전트는 커밋을 하지 않으므로 작업물은 늘 커밋 전 상태다. 지우기 전에 몇 건인지 알려준다.
    const uncommitted = await window.dure.workspaces.uncommitted(workspace.id).catch(() => 0);
    setRemoving({ uncommitted });
  };

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    return window.dure.onChanged((topic) => {
      if (topic === 'terminals') load().catch((e: Error) => setError(e.message));
    });
  }, [load]);

  // 글자 크기 기준으로 대략의 칸 수를 구한다. 터미널이 붙으면 정확한 값으로 다시 맞춘다.
  const size = (): { cols: number; rows: number } => {
    const el = area.current;
    return {
      cols: Math.max(40, Math.floor(((el?.clientWidth ?? 900) - 20) / 7.9)),
      rows: Math.max(10, Math.floor(((el?.clientHeight ?? 600) - 16) / 17)),
    };
  };

  const open = async (kind: 'agent' | 'shell'): Promise<void> => {
    setError('');
    try {
      const t = kind === 'agent'
        ? await window.dure.terminals.startAgent(workspace.id, size())
        : await window.dure.terminals.openShell(workspace.id, size());
      await load();
      setActiveId(t.id);
      // 처음 뜰 때의 폴더 신뢰 창에는 두레가 대신 답한다. 못 넘어가면 '시작 중' 에 머물고 채팅 보기가 터미널로 안내한다.
    } catch (e) {
      setError(describeError((e as Error).message));
    }
  };

  // 끝난 터미널(exitCode 가 있음)은 탭으로 남아 마지막 출력을 보여준다. 살아 있는 에이전트만 "있다"로 친다.
  const hasAgent = terminals.some((t) => t.kind === 'agent' && t.exitCode === undefined);
  const active = terminals.find((t) => t.id === activeId);

  return (
    <div className="ws-view">
      <div className="crumbs">
        {project && <button className="crumb" title="프로젝트 화면으로" onClick={() => onSelect({ type: 'project', id: project.id })}>{project.name}</button>}
        <span className="sep">›</span>
        <span title={repo?.path}>저장소 {repo?.name ?? '(알 수 없음)'}</span>
        <span className="sep">›</span>
        <span>{workspace.name}</span>
        <span className="where" title="이 워크스페이스의 작업 폴더">{workspace.worktreePath}</span>
      </div>
      <div className="ws-head">
        <span className={`dot ${workspace.status}`} />
        <span className="title">{workspace.name}</span>
        <span className="branch">{workspace.branch}</span>
        <span className="tag">{AGENT_LABEL[workspace.agentKind]}</span>
        {workspace.permissionMode === 'bypass' && <span className="tag warn">승인 생략</span>}
        <span className="tag">{STATUS_LABEL[workspace.status]}</span>
        <span className="spacer" />
        <div className="view-switch" role="tablist" aria-label="보기">
          <button role="tab" aria-selected={mode === 'terminal'} className={mode === 'terminal' ? 'on' : ''} onClick={() => switchTo('terminal')} title="에이전트가 도는 터미널을 그대로 봅니다">터미널</button>
          <button
            role="tab" aria-selected={mode === 'chat'} className={mode === 'chat' ? 'on' : ''} disabled={!canChat} onClick={() => switchTo('chat')}
            title={canChat ? '같은 대화를 채팅 형태로 봅니다. 에이전트는 그대로입니다' : 'Codex 는 아직 채팅 보기를 지원하지 않습니다'}
          >채팅</button>
        </div>
        {!hasAgent && <button className="btn primary" onClick={() => void open('agent')}>에이전트 시작</button>}
        {workspace.agentKind === 'claude' && (workspace.status === 'working' || workspace.status === 'waiting_user') && (
          <button className="btn" title="하던 일을 멈춥니다. 에이전트는 꺼지지 않습니다" onClick={() => { window.dure.workspaces.interrupt(workspace.id).catch((e: Error) => setError(e.message)); }}>멈춤</button>
        )}
        <button
          className="btn commit-btn"
          title={commitInfo.hasDraft ? '에이전트가 커밋 메시지를 써 두었습니다' : '바뀐 파일을 보고 커밋합니다'}
          onClick={() => setCommitting(true)}
        >
          커밋{commitInfo.changed > 0 && <span className="n">{commitInfo.changed}</span>}{commitInfo.hasDraft && <span className="pip" />}
        </button>
        <button className="btn ghost danger" onClick={() => void askRemove()}>지우기</button>
      </div>
      <div className="ws-body">
      {mode === 'chat' && (
        <div className="ws-terms">
          <ChatPane
            workspace={workspace} workspaces={workspaces} conversation={conversation} hasAgent={hasAgent}
            onShowTerminal={() => { const agent = terminals.find((t) => t.kind === 'agent'); if (agent) setActiveId(agent.id); switchTo('terminal'); }}
            onStartAgent={() => void open('agent')}
          />
          {error && <div className="error" style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, maxWidth: 420 }}>{error}</div>}
        </div>
      )}
      {mode === 'terminal' && (
      <div className="ws-terms">
      <div className="tabs">
        {terminals.map((t) => (
          <div key={t.id} className={`tab${t.id === activeId ? ' active' : ''}`} onClick={() => setActiveId(t.id)}>
            {t.title}
            {t.exitCode !== undefined && <span className="tag">종료됨 (코드 {t.exitCode})</span>}
            <span className="close" title={t.exitCode === undefined ? '터미널 끄기' : '탭 닫기'} onClick={(e) => { e.stopPropagation(); void window.dure.terminals.kill(t.id); }}>×</span>
          </div>
        ))}
        <button className="btn ghost" title="셸 터미널 열기" onClick={() => void open('shell')}>+</button>
      </div>
      <div className="term-area" ref={area}>
        {active
          ? <TerminalPane key={active.id} terminalId={active.id} />
          : (
            <div className="term-empty">
              {error && <div className="error">{error}</div>}
              <div>{hasAgent ? '터미널을 고르세요.' : '에이전트가 꺼져 있습니다.'}</div>
              {!hasAgent && <button className="btn primary" onClick={() => void open('agent')}>에이전트 시작</button>}
              <div style={{ fontSize: 12 }}>처음 시작할 때 에이전트가 묻는 “이 폴더를 신뢰하는가” 에는 두레가 대신 “신뢰함” 으로 답합니다. 넘어가지 않으면 터미널에서 직접 답하세요.</div>
            </div>
          )}
        {active && error && <div className="error" style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, maxWidth: 420 }}>{error}</div>}
      </div>
      </div>
      )}
      <SidePanel workspace={workspace} workspaces={workspaces} todos={todos} pending={pending} conversation={conversation} />
      </div>
      {committing && <CommitDialog workspace={workspace} onClose={() => setCommitting(false)} />}
      {removing && (
        <ConfirmDialog
          title="워크스페이스 지우기"
          message={`"${workspace.name}" 워크스페이스를 두레에서 지웁니다. 실행 중인 터미널은 꺼집니다. 브랜치 ${workspace.branch} 는 남습니다.`}
          confirmLabel="지우기"
          checkbox={{
            label: removing.uncommitted > 0
              ? `작업 폴더(worktree)도 삭제 — 커밋하지 않은 변경 ${removing.uncommitted}건이 함께 지워집니다`
              : '작업 폴더(worktree)도 삭제',
          }}
          onClose={() => setRemoving(null)}
          onConfirm={async (deleteWorktree) => { await window.dure.workspaces.remove(workspace.id, { deleteWorktree }); }}
        />
      )}
    </div>
  );
}
