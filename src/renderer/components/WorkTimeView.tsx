import { useCallback, useEffect, useState } from 'react';
import type { WorkDay, WorkStatus } from '@shared/types';
import { dayKey, duration, hhmm, monthGrid, monthTotal } from '../worktimeView';

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
                    : status.todayMs > 0 ? <>퇴근했습니다 · <b>오늘 {duration(status.todayMs)}</b></> : <>아직 출근 전입니다{status.atWork ? '' : ' (근무지의 와이파이에 붙으면 출근으로 적습니다)'}</>
                ) : (
                  status.atWork ? <><b>근무 중</b>{status.since ? ` · ${hhmm(status.since)} 부터` : ''} · 오늘 {duration(status.todayMs)}</> : <>근무지의 네트워크가 아닙니다{status.todayMs > 0 ? ` · 오늘 ${duration(status.todayMs)}` : ''}</>
                )}
                <span className="muted"> · {status.ssid ? `지금 와이파이: ${status.ssid}` : status.atWork ? '근무지의 네트워크입니다' : status.ssidHidden ? 'macOS 가 와이파이 이름을 알려 주지 않습니다' : '와이파이에 붙어 있지 않습니다'}</span>
              </span>
              {status.unit === 'half' && (status.openSession
                ? <button className="btn primary" title="지금 시각을 30분 단위로 올려 퇴근으로 적습니다" onClick={() => run(window.dure.worktime.clockOut())}>퇴근</button>
                : <button className="btn" title="지금 시각을 30분 단위로 올려 출근으로 적습니다 (와이파이에 붙으면 저절로 적히지만, 직접 누를 수도 있습니다)" onClick={() => run(window.dure.worktime.clockIn())}>{status.todayMs > 0 ? '다시 출근' : '출근'}</button>)}
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
              {c.data && <><span className="cal-total">{c.data.totalMs > 0 ? duration(c.data.totalMs) : '0분'}</span><span className="cal-range">{hhmm(c.data.firstAt)} ~ {c.data.sessions.some((x) => x.open) ? '근무 중' : hhmm(c.data.lastAt)}</span></>}
            </button>
          )))}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>{picked} {detail && <span className="plan-hint">합계 {detail.totalMs > 0 ? duration(detail.totalMs) : '0분'}</span>}</h2></div>
        <div className="rows">
          {!detail && <div className="rows-empty">이 날의 기록이 없습니다.</div>}
          {detail?.sessions.map((s) => (
            <div key={s.id} className="row">
              <div className="grow">{hhmm(s.startAt)} 출근 ~ {s.open ? '근무 중' : `${hhmm(s.endAt)} 퇴근`}{s.auto && <span className="tag" title="퇴근을 누르지 않아, 마지막으로 근무지에서 확인된 시각으로 닫았습니다">저절로 닫음</span>}</div>
              <span className="muted">{s.open ? '' : s.endAt > s.startAt ? duration(s.endAt - s.startAt) : '0분'}</span>
              <button className="btn ghost" title="잘못 잰 구간을 지웁니다" onClick={() => run(window.dure.worktime.removeSession(s.id))}>지우기</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
