import { useCallback, useEffect, useState } from 'react';
import type { ActivityItem, Workspace } from '@shared/types';

const KIND: Record<ActivityItem['kind'], { label: string; group: string }> = {
  instruction: { label: '지시', group: 'in' }, 'message-in': { label: '받은 메시지', group: 'in' }, 'message-out': { label: '보낸 메시지', group: 'out' },
  artifact: { label: '자료', group: 'out' }, todo: { label: 'TODO', group: 'work' }, commit: { label: '커밋', group: 'work' },
  verify: { label: '확인', group: 'check' }, review: { label: '리뷰', group: 'check' }, ship: { label: '자동 반영', group: 'check' }, figure: { label: '그림', group: 'out' },
};
const FILTERS: { key: string; label: string }[] = [{ key: 'all', label: '전체' }, { key: 'in', label: '받은 것' }, { key: 'work', label: '한 일' }, { key: 'out', label: '보낸 것' }, { key: 'check', label: '확인' }];

const day = (at: number): string => new Date(at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
const time = (at: number): string => new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

/** 작업 기록 (워크스페이스의 "기록" 보기): 받은 지시, 메시지, TODO, 커밋, 확인, 리뷰를 시간순으로. */
export function ActivityPane({ workspace }: { workspace: Workspace }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { window.dure.activity.list(workspace.id).then(setItems).catch(() => setItems([])); }, [workspace.id]);
  useEffect(() => {
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'messages' || topic === 'todos' || topic === 'commit' || topic === 'figures') load(); });
    const t = setInterval(load, 30_000);
    return () => { off(); clearInterval(t); };
  }, [load]);
  if (!items) return <div className="activity"><div className="muted">읽는 중…</div></div>;
  const shown = items.filter((i) => filter === 'all' || KIND[i.kind].group === filter);
  let lastDay = '';
  return (
    <div className="activity">
      <div className="activity-head">
        <b>작업 기록</b>
        <span className="muted">"{workspace.name}" 이(가) 받은 것과 한 것, 새것부터</span>
        <span className="grow" />
        <div className="seg">{FILTERS.map((f) => <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
      </div>
      {shown.length === 0 && <div className="rows-empty">기록이 없습니다.</div>}
      <div className="activity-list">
        {shown.map((i) => {
          const d = day(i.at);
          const head = d !== lastDay ? <div className="activity-day">{d}</div> : null;
          lastDay = d;
          return (
            <div key={i.id}>
              {head}
              <button className={`activity-item k-${i.kind}${i.ok === false ? ' bad' : i.ok ? ' good' : ''}`} onClick={() => setOpen(open === i.id ? null : i.id)}>
                <span className="activity-time">{time(i.at)}</span>
                <span className="tag">{KIND[i.kind].label}</span>
                <span className="activity-title">{i.title}</span>
              </button>
              {i.detail && <div className={`activity-detail${open === i.id ? ' open' : ''}`} onClick={() => setOpen(open === i.id ? null : i.id)}>{i.detail}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
