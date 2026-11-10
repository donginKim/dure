import { useCallback, useEffect, useRef, useState } from 'react';
import { ERROR_PREFIX } from '@shared/ipc';
import type { TerminalInfo, Workspace } from '@shared/types';
import { STATUS_LABEL } from '../tree';
import { ConfirmDialog } from './dialogs';
import { TerminalPane } from './TerminalPane';

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

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const area = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const list = await window.dure.terminals.list(workspace.id);
    // 에이전트 터미널이 첫 탭이다.
    list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'agent' ? -1 : 1));
    setTerminals(list);
    setActiveId((cur) => (cur && list.some((t) => t.id === cur) ? cur : (list[0]?.id ?? null)));
  }, [workspace.id]);

  useEffect(() => {
    void load();
    return window.dure.onChanged((topic) => { if (topic === 'terminals') void load(); });
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
    } catch (e) {
      setError(describeError((e as Error).message));
    }
  };

  const hasAgent = terminals.some((t) => t.kind === 'agent');
  const active = terminals.find((t) => t.id === activeId);

  return (
    <div className="ws-view">
      <div className="ws-head">
        <span className={`dot ${workspace.status}`} />
        <span className="title">{workspace.name}</span>
        <span className="branch">{workspace.branch}</span>
        <span className="tag">{AGENT_LABEL[workspace.agentKind]}</span>
        {workspace.permissionMode === 'bypass' && <span className="tag warn">승인 생략</span>}
        <span className="tag">{STATUS_LABEL[workspace.status]}</span>
        <span className="spacer" />
        {!hasAgent && <button className="btn primary" onClick={() => void open('agent')}>에이전트 시작</button>}
        <button className="btn ghost danger" onClick={() => setRemoving(true)}>지우기</button>
      </div>
      <div className="tabs">
        {terminals.map((t) => (
          <div key={t.id} className={`tab${t.id === activeId ? ' active' : ''}`} onClick={() => setActiveId(t.id)}>
            {t.title}
            <span className="close" title="터미널 끄기" onClick={(e) => { e.stopPropagation(); void window.dure.terminals.kill(t.id); }}>×</span>
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
              <div style={{ fontSize: 12 }}>처음 시작하면 에이전트가 이 폴더를 신뢰하는지 묻습니다. 터미널에서 직접 답하세요.</div>
            </div>
          )}
        {active && error && <div className="error" style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, maxWidth: 420 }}>{error}</div>}
      </div>
      {removing && (
        <ConfirmDialog
          title="워크스페이스 지우기"
          message={`"${workspace.name}" 워크스페이스를 두레에서 지웁니다. 실행 중인 터미널은 꺼집니다. 브랜치 ${workspace.branch} 는 남습니다.`}
          confirmLabel="지우기"
          checkbox={{ label: '작업 폴더(worktree)도 삭제' }}
          onClose={() => setRemoving(false)}
          onConfirm={async (deleteWorktree) => { await window.dure.workspaces.remove(workspace.id, { deleteWorktree }); }}
        />
      )}
    </div>
  );
}
