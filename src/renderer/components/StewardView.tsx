import { useCallback, useEffect, useState } from 'react';
import type { StewardLogEntry, StewardState } from '@shared/types';
import { clock } from '../conversationView';
import { ChatPane } from './ChatPane';
import type { ConversationData } from './ConversationPanel';

const EMPTY_TALK: ConversationData = { threads: [], messages: {}, artifacts: [], flow: { paused: false, capped: false, agentStreak: 0 }, delivery: {} };
const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const APPROVAL: Record<StewardState['approval'], { label: string; help: string }> = {
  suggest: { label: '추천만', help: '아무것도 스스로 정하지 않고, 무엇을 추천하는지 정리해 줍니다.' },
  safe: { label: '안전한 것만 스스로', help: '읽기 승인, 되돌릴 수 있는 질문, 내 에이전트끼리의 약속은 스스로 정하고, 나머지는 추천만 합니다.' },
  all: { label: '전부 스스로', help: '연결 요청의 확인과 예산·사용 한도를 빼고는 스스로 정합니다. 정한 것은 오른쪽 기록에 남습니다.' },
};
const day = (at: number): string => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${clock(at)}`; };

/**
 * 비서: 모든 프로젝트를 보는 에이전트와의 대화, 그리고 비서가 "확인할 것" 을 대신 처리한 기록.
 * 비서는 두레가 관리하는 보이지 않는 프로젝트에 살아, 프로젝트 목록에는 나오지 않는다.
 */
export function StewardView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [state, setState] = useState<StewardState | null>(null);
  const [log, setLog] = useState<StewardLogEntry[]>([]);
  const [error, setError] = useState('');
  const [showLog, setShowLog] = useState(true);

  const load = useCallback(() => {
    window.dure.steward.get().then(setState).catch((e: Error) => setError(clean(e)));
    window.dure.steward.history().then(setLog).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'steward' || topic === 'workspaces' || topic === 'settings') load(); });
  }, [load]);

  if (!state) return <div className="coord"><div className="chat-empty">{error || '비서를 준비하는 중…'}</div></div>;
  const ws = state.workspace;
  const hasAgent = ws.status !== 'stopped';
  const start = (): void => {
    setError('');
    window.dure.terminals.startAgent(ws.id, { cols: 120, rows: 40 }).catch((e: Error) => setError(clean(e)));
  };
  const scope = APPROVAL[state.approval];

  return (
    <div className="coord steward">
      <div className="steward-head">
        <div className="steward-title">{state.name}<span className="plan-hint">모든 프로젝트를 봅니다: 브리핑, TODO 정리, 확인할 것 처리</span></div>
        <span className="spacer" />
        <button className={`tag steward-scope ${state.approval}`} onClick={onOpenSettings} title={`${scope.help} 누르면 설정에서 바꿉니다.`}>승인: {scope.label}</button>
        <button className="tag" onClick={onOpenSettings} title="확인할 것이 생기면 비서에게 저절로 알려 처리하게 합니다. 누르면 설정에서 바꿉니다.">자동 처리: {state.auto ? '켬' : '끔'}</button>
        {hasAgent && <button className="btn ghost" onClick={() => { window.dure.workspaces.stopAgent(ws.id).catch((e: Error) => setError(clean(e))); }}>끄기</button>}
        <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? '기록 접기' : `처리한 것 ${log.length}`}</button>
      </div>
      {error && <div className="error" style={{ margin: '8px 16px 0' }} onClick={() => setError('')}>{error}</div>}
      <div className="coord-main">
        <ChatPane
          workspace={ws} workspaces={[ws]} conversation={EMPTY_TALK} hasAgent={hasAgent}
          onStartAgent={start}
          blank={`"지금 다 어떻게 돼 가?", "밀린 승인 처리해 줘", "쇼핑몰 프로젝트에 할 일 추가해 줘" 처럼 말을 거세요. ${scope.help}`}
        />
        {showLog && (
          <aside className="todo-panel steward-log">
            <div className="side-tabs"><span className="side-tab on">{state.name}가 처리한 것 <span className="count">{log.length}</span></span></div>
            {log.length === 0 && <div className="pin-empty">아직 없습니다. {state.name}가 확인할 것을 대신 정하면 무엇을 왜 그렇게 정했는지 여기에 남습니다.</div>}
            <div className="steward-rows">
              {log.map((l) => {
                const skipped = l.outcome.startsWith('하지 않음') || l.outcome.startsWith('실패');
                return (
                  <div key={l.id} className={`steward-row${skipped ? ' skipped' : ''}`}>
                    <div className="steward-row-head">
                      <span className={`tag ${skipped ? '' : l.decision === 'approve' ? 'ok' : 'warn'}`}>{skipped ? '안 함' : l.decision === 'approve' ? '허용' : '거부'}</span>
                      <span className="steward-row-title">{l.title}</span>
                    </div>
                    <div className="steward-row-meta">{l.projectName || '프로젝트 없음'} · {day(l.at)}</div>
                    <div className="steward-row-outcome">{l.outcome}</div>
                    <div className="steward-row-reason">까닭: {l.reason}</div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
