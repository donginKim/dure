import { useCallback, useEffect, useState } from 'react';
import type { BudgetStatus } from '@shared/types';
import { tokens } from '../usageView';

/** 만 토큰 단위로 받는 칸의 값 → 토큰. 빈 글이면 0 (상한 없음) */
const fromMan = (s: string): number => { const n = Number(s.replace(/[,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 10_000) : 0; };
const toMan = (n: number): string => (n > 0 ? String(Math.round(n / 10_000)) : '');

function Bar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="budget-bar">
      <div className="budget-label"><span>{label}</span><span className="muted">{tokens(used)}{limit > 0 ? ` / ${tokens(limit)} (${pct}%)` : ' · 상한 없음'}</span></div>
      {limit > 0 && <div className={`usage-bar${pct >= 100 ? ' over' : pct >= 80 ? ' near' : ''}`}><span style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

/**
 * 프로젝트의 예산 (사용량 구역의 위). 하루·전체 상한을 만 토큰 단위로 정한다.
 * 넘으면 두레가 이 프로젝트의 에이전트를 멈추고 새로 일을 시키지 않는다. "오늘만 더 쓰기" 로 자정까지 풀 수 있다.
 */
export function BudgetBox({ projectId, readOnly }: { projectId: string; readOnly?: boolean }) {
  const [s, setS] = useState<BudgetStatus | null>(null);
  const [daily, setDaily] = useState('');
  const [total, setTotal] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.projects.budget(projectId).then((b) => { setS(b); setDaily(toMan(b.dailyLimit)); setTotal(toMan(b.totalLimit)); }).catch(() => undefined); }, [projectId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    const off = window.dure.onChanged((topic) => { if (topic === 'projects' || topic === 'attention') load(); });
    return () => { clearInterval(t); off(); };
  }, [load]);
  if (!s) return null;
  const save = (): void => {
    setError('');
    window.dure.projects.setBudget(projectId, fromMan(daily), fromMan(total)).then(setS).catch((e: Error) => setError(e.message));
  };
  return (
    <div className={`budget ${s.state}`}>
      <div className="budget-head">
        <b>예산</b>
        {s.state === 'over' && <span className="tag warn">넘어서 멈춤</span>}
        {s.state === 'warning' && <span className="tag">80% 넘음{s.overrideUntil ? ' · 오늘만 더 쓰는 중' : ''}</span>}
        <span className="grow" />
        {s.state === 'over' && !readOnly && <button className="btn primary" onClick={() => { window.dure.projects.allowToday(projectId).then(setS).catch((e: Error) => setError(e.message)); }} title="오늘 자정까지 상한을 넘어도 멈추지 않습니다">오늘만 더 쓰기</button>}
      </div>
      <Bar label="오늘" used={s.today} limit={s.dailyLimit} />
      <Bar label="전체" used={s.total} limit={s.totalLimit} />
      {!readOnly && (
        <div className="budget-edit">
          <label>하루 <input type="text" inputMode="numeric" value={daily} placeholder="없음" onChange={(e) => setDaily(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /> 만 토큰</label>
          <label>전체 <input type="text" inputMode="numeric" value={total} placeholder="없음" onChange={(e) => setTotal(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /> 만 토큰</label>
          <span className="muted">입력 + 출력으로 셉니다 (캐시에서 읽은 것은 빼고). 넘으면 에이전트를 멈추고 새로 일을 시키지 않습니다. 리뷰 에이전트의 사용량도 셉니다.</span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
