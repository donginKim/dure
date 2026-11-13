import { useCallback, useEffect, useState } from 'react';
import type { UsageSummary } from '@shared/types';
import { inputAll, share, tokens } from '../usageView';
import { BudgetBox } from './BudgetBox';

const RANGES: { label: string; days: number }[] = [{ label: '오늘', days: 1 }, { label: '7일', days: 7 }, { label: '전체', days: 0 }];

/** 프로젝트의 에이전트들이 쓴 토큰. 어느 워크스페이스가 많이 쓰는지 보인다. */
export function UsagePanel({ projectId }: { projectId: string }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UsageSummary | null>(null);
  const load = useCallback(() => { window.dure.usage.summary(projectId, days).then(setData).catch(() => undefined); }, [projectId, days]);
  useEffect(() => {
    load();
    // 에이전트가 일하는 동안 조금씩 늘어난다. 대화가 바뀔 때마다 다시 읽지 않고 가끔만 본다.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return null;
  return (
    <div className="section">
      <div className="section-head">
        <h2>사용량 <span className="plan-hint">에이전트가 쓴 토큰 (두레가 본 대화부터 셉니다. 금액은 요금제에 따라 달라 표시하지 않습니다)</span></h2>
        <div className="seg">{RANGES.map((r) => <button key={r.days} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>{r.label}</button>)}</div>
      </div>
      <BudgetBox projectId={projectId} />
      {data.total.requests === 0 ? <div className="rows"><div className="rows-empty">이 기간에 쓴 것이 없습니다.</div></div> : (
        <div className="rows usage">
          <div className="row usage-head"><div className="grow">워크스페이스</div><div className="usage-num">입력</div><div className="usage-num">그중 캐시</div><div className="usage-num">출력</div><div className="usage-num">요청</div></div>
          {data.workspaces.map((w) => (
            <div key={w.workspaceId} className="row">
              <div className="grow">
                <div>{w.name}{w.gone && <span className="tag">지워짐</span>}</div>
                <div className="usage-bar"><span style={{ width: `${share(w, data.total)}%` }} /></div>
              </div>
              <div className="usage-num">{tokens(inputAll(w))}</div><div className="usage-num muted">{tokens(w.cacheRead)}</div><div className="usage-num">{tokens(w.output)}</div><div className="usage-num muted">{w.requests.toLocaleString('en-US')}</div>
            </div>
          ))}
          <div className="row usage-total">
            <div className="grow">합계{data.models.length > 0 && <span className="muted"> · {data.models.map((m) => m.model).join(', ')}</span>}</div>
            <div className="usage-num">{tokens(inputAll(data.total))}</div><div className="usage-num muted">{tokens(data.total.cacheRead)}</div><div className="usage-num">{tokens(data.total.output)}</div><div className="usage-num muted">{data.total.requests.toLocaleString('en-US')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
