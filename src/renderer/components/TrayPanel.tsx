import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaddyDay, TrayState } from '@shared/types';
import { paddyStage } from './Paddy';
import { STEWARD_FACE } from '../stewardArt';

const MOOD_LABEL: Record<TrayState['mood'], string> = { rest: '다 쉬는 중입니다', work: '에이전트가 일하는 중입니다', wait: '확인을 기다리는 것이 있습니다' };
const STATUS_LABEL: Record<string, string> = { working: '일하는 중', waiting_user: '내 답을 기다림' };
const hours = (ms: number): string => { const min = Math.round(ms / 60_000); const h = Math.floor(min / 60); return h && min % 60 ? `${h}시간 ${min % 60}분` : h ? `${h}시간` : `${min}분`; };
const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const parse = (day: string): Date => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!); };
const CELL = 11; const STEP = 14;

/**
 * 메뉴 막대의 아이콘을 누르면 뜨는 작은 창. 두레의 큰 창을 열지 않고도 본다:
 * 내 확인을 기다리는 것, 일하는 에이전트와 지금 하는 일, 오늘 한 일, 최근 12주의 잔디. 비서에게 한 줄을 보낼 수 있다.
 * 무엇을 누르면 큰 창이 그곳을 열고 이 창은 닫힌다. Esc 로도 닫는다.
 */
export function TrayPanel() {
  const [st, setSt] = useState<TrayState | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const load = useCallback(() => { window.dure.tray.state().then(setSt).catch((e: Error) => setError(clean(e))); }, []);
  useEffect(() => {
    document.documentElement.classList.add('tray-window');
    window.dure.settings.get().then((s) => { document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark'; }).catch(() => undefined);
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.dure.onChanged((topic) => {
      if (topic !== 'attention' && topic !== 'workspaces' && topic !== 'todos' && topic !== 'commit' && topic !== 'worktime') return;
      clearTimeout(timer); timer = setTimeout(load, 300);
    });
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') window.close(); };
    window.addEventListener('keydown', onKey);
    return () => { off(); clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [load]);

  const grass = useMemo(() => {
    if (!st || st.grass.length === 0) return null;
    const row = (d: PaddyDay): number => (parse(d.date).getDay() + 6) % 7;
    const first = row(st.grass[0]!);
    const cells = st.grass.map((d, i) => ({ d, col: Math.floor((i + first) / 7), row: (i + first) % 7 }));
    return { cells, cols: cells[cells.length - 1]!.col + 1 };
  }, [st]);

  if (!st) return <div className="tray"><div className="tray-empty">{error || '불러오는 중…'}</div></div>;
  const open = (target: Parameters<typeof window.dure.tray.open>[0]): void => { window.dure.tray.open(target).catch((e: Error) => setError(clean(e))); };
  const ask = (): void => {
    if (!text.trim() || sending) return;
    setSending(true); setError('');
    window.dure.tray.ask(text).then(() => window.close()).catch((e: Error) => { setError(clean(e)); setSending(false); });
  };
  const today = st.grass[st.grass.length - 1];

  return (
    <div className="tray">
      <button className="tray-head" onClick={() => open({ type: 'steward' })} title="비서 화면을 엽니다">
        <img className="steward-face" src={STEWARD_FACE[st.mood]} alt="" width={34} height={34} />
        <span className="tray-head-text"><b>{st.stewardName}</b><span className={`tray-mood ${st.mood}`}>{MOOD_LABEL[st.mood]}</span></span>
        <span className="tray-open">두레 열기</span>
      </button>
      {error && <div className="error tray-error" onClick={() => setError('')}>{error}</div>}
      <div className="tray-body">
        <section>
          <div className="tray-sec-head"><span>확인할 것</span>{st.waitingCount > 0 && <span className="count warn">{st.waitingCount}</span>}</div>
          {st.waitingCount === 0 ? <div className="tray-none">기다리는 것이 없습니다.</div> : (
            <ul className="tray-list">
              {st.waiting.map((a) => (
                <li key={a.id}><button onClick={() => open({ type: 'attention', item: a })}>
                  <span className="tray-row-title">{a.title}</span>
                  <span className="tray-row-meta">{a.projectName || '프로젝트 없음'}{a.detail ? ` · ${a.detail}` : ''}</span>
                </button></li>
              ))}
              {st.waitingCount > st.waiting.length && <li><button className="tray-more" onClick={() => open({ type: 'attentionList' })}>외 {st.waitingCount - st.waiting.length}건 모두 보기</button></li>}
            </ul>
          )}
        </section>
        <section>
          <div className="tray-sec-head"><span>에이전트</span>{st.agents.length > 0 && <span className="count">{st.agents.length}</span>}</div>
          {st.agents.length === 0 ? <div className="tray-none">일하는 에이전트가 없습니다.</div> : (
            <ul className="tray-list">
              {st.agents.map((a) => (
                <li key={a.workspaceId}><button onClick={() => open({ type: 'workspace', id: a.workspaceId, projectId: a.projectId })}>
                  <span className="tray-row-title"><span className={`dot ${a.status}`} /> {a.project} · {a.name}<span className="tray-status">{STATUS_LABEL[a.status] ?? ''}</span></span>
                  {a.doing && <span className="tray-row-meta">{a.doing}</span>}
                </button></li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <div className="tray-sec-head"><span>오늘</span></div>
          <div className="tray-tiles">
            <div><b>{st.today.workMs > 0 ? hours(st.today.workMs) : '—'}</b><span>근무</span></div>
            <div><b>{st.today.done}</b><span>끝낸 일</span></div>
            <div><b>{st.today.commits}</b><span>커밋</span></div>
            <div><b>{st.today.mains}</b><span>반영</span></div>
          </div>
        </section>
        {grass && (
          <section>
            <div className="tray-sec-head"><span>잔디</span><span className="tray-sub">최근 12주</span></div>
            <svg className="sprout tray-grass" viewBox={`0 0 ${grass.cols * STEP} ${7 * STEP}`} role="img" aria-label="최근 12주, 날마다 한 일">
              {grass.cells.map(({ d, col, row }) => (
                <rect key={d.date} x={col * STEP} y={row * STEP} width={CELL} height={CELL} rx={3}
                  className={`grass-cell still l${paddyStage(d.score)}${d === today ? ' today' : ''}${d === today && st.mood === 'work' ? ' live' : ''}`} style={{ animationDelay: `${col * 28 + row * 14}ms` }}>
                  <title>{`${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))} · 끝낸 일 ${d.todos} · 커밋 ${d.commits}${d.mains ? ` · 반영 ${d.mains}` : ''}`}</title>
                </rect>
              ))}
            </svg>
          </section>
        )}
      </div>
      <div className="tray-ask">
        <input value={text} placeholder={`${st.stewardName}에게 한 줄 (Enter)`} disabled={sending} aria-label={`${st.stewardName}에게 보낼 글`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); ask(); } }} />
        <button className="btn primary" disabled={!text.trim() || sending} onClick={ask}>{sending ? '보내는 중' : '보내기'}</button>
      </div>
    </div>
  );
}
