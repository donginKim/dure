import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlackCall, SlackWatchStatus, StewardLogEntry, StewardState } from '@shared/types';
import { clock } from '../conversationView';
import { ChatPane } from './ChatPane';
import { StewardBoardView } from './StewardBoardView';
import type { ConversationData } from './ConversationPanel';
import { STEWARD_ART, STEWARD_FACE, STEWARD_MOOD_LABEL, stewardMood } from '../stewardArt';

const EMPTY_TALK: ConversationData = { threads: [], messages: {}, artifacts: [], flow: { paused: false, capped: false, agentStreak: 0 }, delivery: {} };
const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const APPROVAL: Record<StewardState['approval'], { label: string; help: string }> = {
  suggest: { label: '추천만', help: '아무것도 스스로 정하지 않고, 무엇을 추천하는지 정리해 줍니다.' },
  safe: { label: '안전한 것만 스스로', help: '읽기만 하는 승인과 되돌릴 수 있는 질문(추천 답)은 스스로 정하고, 나머지는 추천만 합니다.' },
  all: { label: '전부 스스로', help: '연결 요청의 확인과 예산·사용 한도를 빼고는 스스로 정합니다. 정한 것은 오른쪽 기록에 남습니다.' },
};
const CALL_KIND: Record<SlackCall['kind'], string> = { mention: '언급', here: '@here', dm: '개인 메시지' };
const day = (at: number): string => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${clock(at)}`; };

/**
 * 비서: 모든 프로젝트를 보는 에이전트와의 대화, 그리고 비서가 "확인할 것" 을 대신 처리한 기록.
 * 비서는 두레가 관리하는 보이지 않는 프로젝트에 살아, 프로젝트 목록에는 나오지 않는다.
 */
export function StewardView({ onOpenSettings, onOpenProject, onOpenWorkspace }: { onOpenSettings: () => void; onOpenProject: (id: string) => void; onOpenWorkspace: (id: string, projectId: string) => void }) {
  const [view, setView] = useState<'talk' | 'board'>('talk');
  const boardOpened = useRef(false);
  if (view === 'board') boardOpened.current = true;
  const [state, setState] = useState<StewardState | null>(null);
  const [log, setLog] = useState<StewardLogEntry[]>([]);
  const [error, setError] = useState('');
  const [showLog, setShowLog] = useState(true);
  const [calls, setCalls] = useState<SlackCall[]>([]);
  const [watch, setWatch] = useState<SlackWatchStatus | null>(null);
  const [tab, setTab] = useState<'log' | 'slack'>('log');
  const [checking, setChecking] = useState(false);
  const opened = useRef(false);
  const loadCalls = useCallback(() => {
    window.dure.slackWatch.status().then((st) => {
      setWatch(st);
      // 처음 열었을 때 안 본 글이 있으면 그 목록부터 보여 준다 (알림을 눌러 들어온 경우 포함).
      if (!opened.current) { opened.current = true; if (st.enabled && st.unseen > 0) setTab('slack'); }
    }).catch(() => undefined);
    window.dure.slackWatch.calls().then(setCalls).catch(() => undefined);
  }, []);
  useEffect(() => {
    loadCalls();
    const offOpen = window.dure.slackWatch.onOpen(() => { setShowLog(true); setTab('slack'); });
    const off = window.dure.onChanged((topic) => { if (topic === 'slackWatch' || topic === 'slack' || topic === 'settings') loadCalls(); });
    return () => { off(); offOpen(); };
  }, [loadCalls]);

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
  /** 현황판에서 비서에게 시킨다: 꺼져 있으면 켜고, 받을 수 있게 되면 보낸다. */
  const ask = (text: string): void => {
    setView('talk'); setError('');
    void (async () => {
      if ((await window.dure.steward.get()).workspace.status === 'stopped') await window.dure.terminals.startAgent(ws.id, { cols: 120, rows: 40 });
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        const st = (await window.dure.steward.get()).workspace.status;
        ready = st === 'idle' || st === 'working';
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      if (!ready) throw new Error(`${state.name}가 아직 글을 받을 수 없습니다 (켜지는 중이거나 확인을 기다립니다). 잠시 뒤 총괄 현황판에서 다시 눌러 주세요.`);
      await window.dure.chat.send(ws.id, text);
    })().catch((e: Error) => setError(clean(e)));
  };
  const scope = APPROVAL[state.approval];
  const mood = stewardMood(ws.status);

  return (
    <div className="coord steward">
      <div className="steward-head">
        <img className="steward-face" src={STEWARD_FACE[mood]} alt="" title={STEWARD_MOOD_LABEL[mood]} width={40} height={40} />
        <div className="steward-title">{state.name}<span className="plan-hint">모든 프로젝트를 봅니다: 브리핑, TODO 정리, 확인할 것 처리</span></div>
        <div className="sb-seg steward-views" role="group" aria-label="비서 화면">
          <button className={view === 'talk' ? 'on' : ''} aria-pressed={view === 'talk'} onClick={() => setView('talk')}>대화</button>
          <button className={view === 'board' ? 'on' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')} title="모든 프로젝트에서 얼마나, 무엇을 했는지와 주간 보고의 초안">총괄 현황판</button>
        </div>
        <span className="spacer" />
        <button className={`tag steward-scope ${state.approval}`} onClick={onOpenSettings} title={`${scope.help} 누르면 설정에서 바꿉니다.`}>승인: {scope.label}</button>
        <button className="tag" onClick={onOpenSettings} title="확인할 것이 생기면 비서에게 저절로 알려 처리하게 합니다. 누르면 설정에서 바꿉니다.">자동 처리: {state.auto ? '켬' : '끔'}</button>
        {hasAgent && <button className="btn ghost" onClick={() => { window.dure.workspaces.stopAgent(ws.id).catch((e: Error) => setError(clean(e))); }}>끄기</button>}
        {watch?.enabled && watch.unseen > 0 && <button className="tag warn" title="슬랙에서 나를 부른 글 중 아직 보지 않은 것" onClick={() => { setShowLog(true); setTab('slack'); }}>슬랙 {watch.unseen}</button>}
        {view === 'talk' && <button className="btn ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? '옆 접기' : `처리한 것 ${log.length}`}</button>}
      </div>
      {error && <div className="error" style={{ margin: '8px 16px 0' }} onClick={() => setError('')}>{error}</div>}
      {state.blocked && (
        <div className="notice" style={{ margin: '8px 16px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{state.name}가 오늘 쓸 수 있는 토큰의 상한을 넘어 멈췄습니다. 상한은 설정의 "프로젝트 기본 하루 예산" 을 따릅니다.</span>
          <span className="spacer" />
          <button className="btn" onClick={() => { window.dure.projects.allowToday(state.project.id).then(load).catch((e: Error) => setError(clean(e))); }}>오늘만 더 쓰기</button>
        </div>
      )}
      {state.asks.length > 0 && (
        <div className="notice steward-asks" style={{ margin: '8px 16px 0' }} title="비서가 조율 에이전트에게 전한 글입니다. 그 에이전트의 차례가 끝나면 두레가 답을 비서에게 넘기고, 비서가 여기 대화에서 알려 줍니다.">
          {state.asks.map((a) => (
            <div key={a.id}>
              <span className={`tag ${a.answeredAt !== null ? 'ok' : a.late ? 'warn' : ''}`} title={a.answeredAt !== null ? '답은 왔는데 비서에게 아직 넘기지 못했습니다 (저절로 알리는 횟수의 상한이나 예산). 비서에게 "답 왔어?" 라고 물으면 바로 봅니다.' : undefined}>{a.answeredAt !== null ? '답이 옴' : a.late ? '답이 늦음' : '답 기다리는 중'}</span>{' '}
              {a.projectName}의 조율 에이전트 · {day(a.askedAt)}에 전함 · <span className="muted">{a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* 한 번 연 현황판은 대화로 가도 내리지 않는다: 고친 초안과 고른 기간이 남는다. */}
      {(view === 'board' || boardOpened.current) && <div className="steward-board-wrap" hidden={view !== 'board'}><StewardBoardView name={state.name} onOpenProject={onOpenProject} onOpenWorkspace={onOpenWorkspace} onAsk={ask} /></div>}
      {view === 'talk' && <div className="coord-main">
        <ChatPane
          workspace={ws} workspaces={[ws]} conversation={EMPTY_TALK} hasAgent={hasAgent}
          onStartAgent={start}
          blankArt={<img className={`steward-art ${mood}`} src={STEWARD_ART[mood]} alt={`${state.name}: ${STEWARD_MOOD_LABEL[mood]}`} width={168} height={168} />}
          blank={`"지금 다 어떻게 돼 가?", "밀린 승인 처리해 줘", "쇼핑몰 프로젝트에 할 일 추가해 줘" 처럼 말을 거세요. ${scope.help}`}
        />
        {showLog && (
          <aside className="todo-panel steward-log">
            <div className="side-tabs">
              <button className={`side-tab${tab === 'log' ? ' on' : ''}`} onClick={() => setTab('log')}>{state.name}가 처리한 것 <span className="count">{log.length}</span></button>
              <button className={`side-tab${tab === 'slack' ? ' on' : ''}`} onClick={() => setTab('slack')}>슬랙에서 부른 것 {watch && watch.unseen > 0 && <span className="count">{watch.unseen}</span>}</button>
            </div>
            {tab === 'slack' && (
              <>
                {!watch?.enabled && <div className="pin-empty">꺼져 있습니다. 켜면 슬랙에서 나를 언급한 글, 내가 든 채널의 @here, 개인 메시지를 두레가 5분마다 찾아 알립니다. <button className="link" onClick={onOpenSettings}>설정에서 켜기</button></div>}
                {watch?.enabled && !watch.connected && <div className="pin-empty">슬랙이 연결돼 있지 않습니다. <button className="link" onClick={onOpenSettings}>설정 &gt; 슬랙에서 연결</button></div>}
                {watch?.enabled && watch.connected && (
                  <div className="steward-watch-bar">
                    <span className="muted">{watch.lastRunAt ? `${day(watch.lastRunAt)} 확인 · 채널 ${watch.channels}` : '아직 확인 전'}</span>
                    <span className="spacer" />
                    <button className="link" disabled={checking} onClick={() => { setChecking(true); window.dure.slackWatch.checkNow().then(setWatch).catch((e: Error) => setError(clean(e))).finally(() => setChecking(false)); }}>{checking ? '확인 중…' : '지금 확인'}</button>
                    {watch.unseen > 0 && <button className="link" onClick={() => { window.dure.slackWatch.seen().catch((e: Error) => setError(clean(e))); }}>모두 봤음</button>}
                  </div>
                )}
                {watch?.enabled && watch.connected && watch.lastError && <div className="notice" style={{ margin: '6px 10px' }}>{watch.lastError}</div>}
                {watch?.enabled && watch.connected && calls.length === 0 && <div className="pin-empty">아직 없습니다. 켠 뒤에 올라온 글만 알립니다.</div>}
                <div className="steward-rows">
                  {watch?.enabled && calls.map((c) => (
                    <div key={c.id} className={`steward-row${c.seen ? ' skipped' : ''}`}>
                      <div className="steward-row-head">
                        <span className={`tag ${c.kind === 'mention' ? 'warn' : c.kind === 'dm' ? 'ok' : ''}`}>{CALL_KIND[c.kind]}</span>
                        <span className="steward-row-title">{c.userName}</span>
                      </div>
                      <div className="steward-row-meta">{c.channelName} · {day(Number(c.ts.split('.')[0]) * 1000)}</div>
                      <div className="steward-row-outcome steward-call-text">{c.text}</div>
                      <div className="steward-row-reason">
                        {c.permalink && <button className="link" onClick={() => { window.dure.slackWatch.open(c.id).catch((e: Error) => setError(clean(e))); }}>슬랙에서 열기</button>}
                        {!c.seen && <button className="link" style={{ marginLeft: 10 }} onClick={() => { window.dure.slackWatch.seen([c.id]).catch((e: Error) => setError(clean(e))); }}>봤음</button>}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {tab === 'log' && log.length === 0 && <div className="pin-empty">아직 없습니다. {state.name}가 확인할 것을 대신 정하면 무엇을 왜 그렇게 정했는지 여기에 남습니다.</div>}
            {tab === 'log' && <div className="steward-rows">
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
            </div>}
          </aside>
        )}
      </div>}
    </div>
  );
}
