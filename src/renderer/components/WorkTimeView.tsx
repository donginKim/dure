import { useCallback, useEffect, useState } from 'react';
import type { WorkDay, WorkStatus } from '@shared/types';
import { atTime, breakLabel, canLeave, leftToLeave, dayKey, duration, hhmm, monthGrid, monthTotal, parseBreak } from '../worktimeView';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 근무시간 달력. 근무지의 와이파이에 붙어 있던 시간을 날마다 보여 준다.
 * 두레가 켜져 있는 동안 1분마다 확인해 적는다.
 */
export function WorkTimeView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const [days, setDays] = useState<WorkDay[]>([]);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [picked, setPicked] = useState<string>(dayKey(now.getFullYear(), now.getMonth() + 1, now.getDate()));
  const [error, setError] = useState('');
  const load = useCallback(() => {
    void Promise.all([window.dure.worktime.month(ym.y, ym.m), window.dure.worktime.status()]).then(([d, s]) => { setDays(d); setStatus(s); }).catch((e: Error) => setError(e.message));
  }, [ym]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'worktime' || topic === 'settings') load(); });
  }, [load]);
  const move = (by: number): void => setYm(({ y, m }) => { const d = new Date(y, m - 1 + by, 1); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const today = dayKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const total = monthTotal(days);
  const detail = days.find((d) => d.day === picked);
  const run = (p: Promise<unknown>): void => { setError(''); p.catch((e: Error) => setError(e.message)).finally(load); };

  return (
    <div className="page">
      <h1>근무시간</h1>
      <p className="lead">근무지의 와이파이에 붙어 있는 동안을 근무시간으로 잽니다. 두레가 켜져 있을 때만 잽니다. 근무지의 와이파이에 붙으면 그날의 출근을 적고, 퇴근은 아래의 퇴근 단추로 적습니다. 시각은 30분 단위로 올려 적습니다 (09:14 → 09:30, 15:20 → 15:30).</p>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      {status && (
        <div className={`work-status${status.atWork ? ' on' : ''}`}>
          {!status.enabled ? (
            <><span className="grow">근무시간을 재지 않고 있습니다. 설정에서 켜고 근무지의 와이파이 이름을 적으세요.</span><button className="btn primary" onClick={onOpenSettings}>설정 열기</button></>
          ) : (
            <>
              <span className={`dot ${status.openSession || (status.unit === 'minute' && status.atWork) ? 'working' : 'stopped'}`} />
              <span className="grow">
                {status.unit === 'half' ? (
                  status.openSession
                    ? <><b>근무 중</b> · {hhmm(status.openSession.startAt)} 출근 · <b>오늘 {status.todayMs > 0 ? duration(status.todayMs) : '0분'}</b></>
                    : status.clockedOut ? <>퇴근했습니다 · <b>오늘 {status.todayMs > 0 ? duration(status.todayMs) : '0분'}</b></> : <>아직 출근 전입니다{status.atWork ? '' : ' (근무지의 와이파이에 붙으면 출근으로 적습니다)'}</>
                ) : (
                  status.atWork ? <><b>근무 중</b>{status.since ? ` · ${hhmm(status.since)} 부터` : ''} · 오늘 {duration(status.todayMs)}</> : <>근무지의 네트워크가 아닙니다{status.todayMs > 0 ? ` · 오늘 ${duration(status.todayMs)}` : ''}</>
                )}
                {canLeave(status)
                  ? <b className="work-leave" title={`오늘 ${duration(status.targetMs)}(휴게 시간을 뺀 것)을 채웠습니다`}>퇴근 가능!</b>
                  : (status.openSession || (status.unit === 'minute' && status.atWork)) && leftToLeave(status) >= 60_000 && <span className="muted"> · 퇴근까지 {duration(leftToLeave(status))}</span>}
                <span className="muted"> · {status.ssid ? `지금 와이파이: ${status.ssid}` : status.atWork ? '근무지의 네트워크입니다' : status.ssidHidden ? 'macOS 가 와이파이 이름을 알려 주지 않습니다' : '와이파이에 붙어 있지 않습니다'}</span>
              </span>
              {status.unit === 'half' && (status.openSession
                ? <button className="btn primary" title="지금 시각을 30분 단위로 올려 퇴근으로 적습니다" onClick={() => run(window.dure.worktime.clockOut())}>퇴근</button>
                : <button className="btn" title="지금 시각을 30분 단위로 올려 출근으로 적습니다 (와이파이에 붙으면 저절로 적히지만, 직접 누를 수도 있습니다)" onClick={() => run(window.dure.worktime.clockIn())}>{status.clockedOut ? '다시 출근' : '출근'}</button>)}
              {!status.atWork && !status.remembered && <button className="btn" title="와이파이 이름을 읽을 수 없을 때: 지금 붙어 있는 네트워크(공유기)를 근무지로 기억합니다" onClick={() => run(window.dure.worktime.rememberCurrent())}>지금 네트워크를 근무지로 기억</button>}
              <button className="btn ghost" onClick={onOpenSettings}>설정</button>
            </>
          )}
        </div>
      )}
      {status?.enabled && status.ssidHidden && !status.atWork && (
        <div className="notice">
          macOS 는 위치 권한이 없는 앱에게 와이파이 이름을 알려 주지 않습니다. 근무지에 있을 때 위의 <b>"지금 네트워크를 근무지로 기억"</b> 을 한 번 누르면, 이름 대신 그 네트워크의 공유기로 알아봅니다 (권한이 필요 없습니다).
          이름으로 알아보게 하려면 <button className="link" onClick={() => { navigator.geolocation.getCurrentPosition(() => load(), () => load()); }}>위치 권한을 요청</button>하고 macOS 의 창에서 허용하세요.
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>{ym.y}년 {ym.m}월 <span className="plan-hint">근무한 날 {total.days}일 · 합계 {total.ms > 0 ? duration(total.ms) : '0분'}</span></h2>
          <div className="seg"><button onClick={() => move(-1)}>‹ 이전 달</button><button onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() + 1 })}>이번 달</button><button onClick={() => move(1)}>다음 달 ›</button></div>
        </div>
        <div className="cal">
          {WEEK.map((w, i) => <div key={w} className={`cal-week${i === 0 || i === 6 ? ' weekend' : ''}`}>{w}</div>)}
          {monthGrid(ym.y, ym.m, days).map((c) => (c.day === null ? <div key={c.key} className="cal-cell blank" /> : (
            <button key={c.key} className={`cal-cell${c.weekend ? ' weekend' : ''}${c.key === today ? ' today' : ''}${c.key === picked ? ' picked' : ''}${c.data ? ' has' : ''}`} onClick={() => setPicked(c.key)}>
              <span className="cal-day">{c.day}</span>
              {c.data && <><span className="cal-total">{c.data.totalMs > 0 ? duration(c.data.totalMs) : '0분'}</span>{c.data.sessions.length > 0 && <span className="cal-range">{hhmm(c.data.firstAt)} ~ {c.data.sessions.some((x) => x.open) ? '근무 중' : hhmm(c.data.lastAt)}</span>}{c.data.breakMin > 0 && <span className="cal-break">휴게 {breakLabel(c.data.breakMin)}</span>}</>}
            </button>
          )))}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>{picked} {detail && <span className="plan-hint">근무 {detail.totalMs > 0 ? duration(detail.totalMs) : '0분'}{detail.breakMin > 0 && ` (출근해 있던 ${duration(detail.grossMs)} 에서 휴게 ${breakLabel(detail.breakMin)} 을 뺌)`}</span>}</h2></div>
        <div className="rows">
          {!detail?.sessions.length && <div className="rows-empty">이 날의 출퇴근 기록이 없습니다.</div>}
          {detail?.sessions.map((x) => (
            <div key={`${x.id}:${x.startAt}:${x.endAt}:${x.open}`} className="row">
              <div className="grow work-edit">
                <TimeField label="출근" value={hhmm(x.startAt)} onCommit={(t) => { const at = atTime(picked, t); if (at !== null) run(window.dure.worktime.editSession(x.id, { startAt: at })); }} />
                <span className="muted">~</span>
                <TimeField label="퇴근" value={x.open ? '' : hhmm(x.endAt)} placeholder="근무 중" onCommit={(t) => { const at = atTime(picked, t); if (at !== null) run(window.dure.worktime.editSession(x.id, { endAt: at })); }} />
                {x.auto && <span className="tag" title="퇴근을 누르지 않아, 마지막으로 근무지에서 확인된 시각으로 닫았습니다">저절로 닫음</span>}
              </div>
              <span className="muted">{x.open ? '근무 중' : x.endAt > x.startAt ? duration(x.endAt - x.startAt) : '0분'}</span>
              <button className="btn ghost" title="이 기록을 지웁니다" onClick={() => run(window.dure.worktime.removeSession(x.id))}>지우기</button>
            </div>
          ))}
        </div>
        <AddSession key={picked} day={picked} onAdd={(a, b) => run(window.dure.worktime.addSession(a, b))} />
        <BreakEditor key={`${picked}:${detail?.breakMin ?? 0}`} day={picked} minutes={detail?.breakMin ?? 0} onSave={(m) => run(window.dure.worktime.setBreak(picked, m))} />
      </div>
    </div>
  );
}

/** 고른 날의 휴게 시간을 적는다. 근무시간에서 뺀다. */
function BreakEditor({ day, minutes, onSave }: { day: string; minutes: number; onSave: (minutes: number) => void }) {
  const [text, setText] = useState(minutes > 0 ? String(minutes) : '');
  const parsed = parseBreak(text);
  const bad = parsed === null || parsed > 24 * 60;
  return (
    <div className="work-break">
      <div className="grow">
        <b>휴게 시간</b> <span className="muted">{minutes > 0 ? `${breakLabel(minutes)} · 근무시간에서 뺍니다` : '적지 않았습니다. 점심처럼 쉰 시간을 적으면 그날의 근무시간에서 뺍니다'}</span>
      </div>
      <div className="seg">{[30, 60, 90].map((m) => <button key={m} className={minutes === m ? 'on' : ''} onClick={() => onSave(m)}>{breakLabel(m)}</button>)}</div>
      <input type="text" className={`work-break-input${bad ? ' bad' : ''}`} value={text} placeholder="분 (예: 60, 1:30)" title={`${day} 의 휴게 시간. 분으로 적거나 1:30, 1시간 30분처럼 적습니다`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !bad && !e.nativeEvent.isComposing) onSave(parsed!); }} />
      <button className="btn" disabled={bad || parsed === minutes} onClick={() => onSave(parsed!)}>적기</button>
      {minutes > 0 && <button className="btn ghost" onClick={() => onSave(0)}>지우기</button>}
    </div>
  );
}

/** 시각을 고치는 칸. 고친 뒤 Enter 를 누르거나 칸을 벗어나면 적는다. */
function TimeField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (time: string) => void }) {
  const [text, setText] = useState(value);
  const commit = (): void => { if (text && text !== value) onCommit(text); };
  return (
    <label className="work-time" title={`${label} 시각을 고칩니다. 고친 뒤 Enter 를 누르세요`}>
      <span className="muted">{label}</span>
      <input type="time" step={1800} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} />
      {!text && placeholder && <span className="muted">{placeholder}</span>}
    </label>
  );
}

/** 기록을 직접 더한다 (두레를 켜 두지 않은 날, 빠진 구간). */
function AddSession({ day, onAdd }: { day: string; onAdd: (startAt: number, endAt: number) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('18:00');
  const a = atTime(day, from); const b = atTime(day, to);
  const bad = a === null || b === null || b < a;
  if (!open) return <button className="btn ghost work-add" onClick={() => setOpen(true)}>+ 이 날의 기록 직접 더하기</button>;
  return (
    <div className="work-break">
      <div className="grow"><b>기록 더하기</b> <span className="muted">{day} 의 출근과 퇴근 시각을 적습니다</span></div>
      <label className="work-time"><span className="muted">출근</span><input type="time" step={1800} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="work-time"><span className="muted">퇴근</span><input type="time" step={1800} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <button className="btn primary" disabled={bad} onClick={() => { onAdd(a!, b!); setOpen(false); }}>더하기</button>
      <button className="btn ghost" onClick={() => setOpen(false)}>취소</button>
    </div>
  );
}
