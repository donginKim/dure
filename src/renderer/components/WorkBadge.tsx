import { useCallback, useEffect, useState } from 'react';
import type { WorkStatus } from '@shared/types';
import { duration, hhmm, workBadge } from '../worktimeView';

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
  return (
    <button className="work-badge" onClick={onOpen} title={`${since ? `${hhmm(since)} 출근 · ` : ''}오늘 ${status.todayMs > 0 ? duration(status.todayMs) : '0분'} (휴게 시간을 뺀 것). 누르면 근무시간 화면이 열립니다`}>
      <span className="dot working" />{text}
    </button>
  );
}
