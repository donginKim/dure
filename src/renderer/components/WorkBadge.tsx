import { useCallback, useEffect, useState } from 'react';
import type { WorkStatus } from '@shared/types';
import { canLeave, duration, hhmm, leftToLeave, workBadge } from '../worktimeView';

/**
 * 창의 오른쪽 아래에 떠 있는 근무 표시: 근무 중일 때 오늘 몇 시간째인지 보인다. 누르면 근무시간 화면이 열린다.
 * 근무 중이 아니면 보이지 않는다.
 */
export function WorkBadge({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const load = useCallback(() => { window.dure.worktime.status().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    // 시간이 흐르는 것을 보이려고 가끔 다시 읽는다.
    const t = setInterval(load, 30_000);
    const off = window.dure.onChanged((topic) => { if (topic === 'worktime' || topic === 'settings') load(); });
    return () => { clearInterval(t); off(); };
  }, [load]);
  const text = status ? workBadge(status) : null;
  if (!status || !text) return null;
  const since = status.openSession?.startAt ?? status.since;
  const leave = canLeave(status);
  const left = leftToLeave(status);
  return (
    <button className={`work-badge${leave ? ' leave' : ''}`} onClick={onOpen} title={`${since ? `${hhmm(since)} 출근 · ` : ''}오늘 ${status.todayMs > 0 ? duration(status.todayMs) : '0분'} (휴게 시간을 뺀 것)${leave ? ` · ${duration(status.targetMs)}을 채웠습니다` : left >= 60_000 ? ` · 퇴근까지 ${duration(left)}` : ''}. 누르면 근무시간 화면이 열립니다`}>
      <span className="dot working" />{text}{leave && <b className="work-leave">퇴근 가능!</b>}
    </button>
  );
}
