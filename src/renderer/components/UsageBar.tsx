import { useEffect, useRef, useState } from 'react';
import type { UsageBar as Bar } from '@shared/types';

export const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const hhmm = (sec: number): string => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const KIND: Record<string, string> = { five_hour: '5시간', seven_day: '7일', seven_day_opus: '7일 (Opus)', seven_day_sonnet: '7일 (Sonnet)' };
const short = (m: string): string => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)/, ' $1.$2').replace(/\[.*\]$/, '');

/** 최근 7일 막대 (오늘이 오른쪽 끝) */
function Spark({ week }: { week: number[] }) {
  const max = Math.max(1, ...week);
  return (
    <svg className="ub-spark" viewBox="0 0 42 14" width="42" height="14" aria-hidden>
      {week.map((v, i) => { const h = Math.max(1, Math.round((v / max) * 13)); return <rect key={i} x={i * 6} y={14 - h} width="4" height={h} rx="1" className={i === week.length - 1 ? 'today' : ''} />; })}
    </svg>
  );
}

/**
 * 하단바: 이 PC 의 두레 에이전트들이 오늘 쓴 토큰과 계정의 사용 한도를 한 줄로 본다. 누르면 프로젝트·모델별로 펼친다.
 * 토큰은 예산과 같은 셈(입력 + 캐시 쓰기 + 출력)이다. 캐시에서 읽은 것은 따로 보인다.
 */
export function UsageBar() {
  const [b, setB] = useState<Bar | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => { window.dure.projects.usageBar().then((x) => { if (alive) setB(x); }).catch(() => undefined); };
    load();
    const t = setInterval(load, 15_000);
    const off = window.dure.onChanged((topic) => { if (topic === 'workspaces' || topic === 'chat') load(); });
    return () => { alive = false; clearInterval(t); off(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!b) return <div className="statusbar" />;
  const total = b.models.reduce((n, m) => n + m.counted, 0) || 1;
  const lim = b.limit;
  const limText = lim
    ? `${lim.status === 'rejected' ? '한도 걸림' : lim.status === 'warning' ? '한도 가까움' : '한도 여유'}${lim.kind ? ` (${KIND[lim.kind] ?? lim.kind})` : ''}${lim.utilization !== null ? ` ${Math.round(lim.utilization * (lim.utilization <= 1 ? 100 : 1))}%` : ''}${lim.resetsAt ? ` · ${hhmm(lim.resetsAt)} 풀림` : ''}`
    : '';
  return (
    <div className="statusbar" ref={box}>
      <button className="ub-main" onClick={() => setOpen((v) => !v)} title="이 PC 의 두레 에이전트가 오늘 쓴 토큰입니다 (입력 + 캐시 쓰기 + 출력. 캐시에서 읽은 것은 따로). 누르면 프로젝트·모델별로 봅니다">
        <span className={`dot ${b.working ? 'working' : 'idle'}`} />
        <span>일하는 에이전트 <b>{b.working}</b></span>
        <span className="ub-sep" />
        <span>오늘 <b>{tokens(b.today.counted)}</b> 토큰</span>
        <Spark week={b.week} />
        <span className="muted">캐시 읽기 {tokens(b.today.cacheRead)} · 요청 {b.today.requests.toLocaleString('ko-KR')}</span>
        {b.models.length > 0 && <><span className="ub-sep" /><span className="muted">{b.models.slice(0, 2).map((m) => `${short(m.model)} ${Math.round((m.counted / total) * 100)}%`).join(' · ')}</span></>}
        {lim && <><span className="ub-sep" /><span className={`ub-limit ${lim.status}`}>{limText}</span></>}
      </button>
      {open && (
        <div className="ub-pop" role="dialog" aria-label="오늘 사용량">
          <div className="ub-pop-head">오늘 쓴 토큰 <span className="muted">(입력 + 캐시 쓰기 + 출력)</span></div>
          {b.projects.length === 0 && <div className="muted">오늘은 아직 쓴 것이 없습니다.</div>}
          {b.projects.map((p) => (
            <div key={p.projectId} className="ub-row"><span className="grow">{p.name}</span><span className="ub-barwrap"><span style={{ width: `${Math.round((p.counted / Math.max(1, b.today.counted)) * 100)}%` }} /></span><b>{tokens(p.counted)}</b></div>
          ))}
          {b.models.length > 0 && <div className="ub-pop-head" style={{ marginTop: 8 }}>모델</div>}
          {b.models.map((m) => <div key={m.model} className="ub-row"><span className="grow">{short(m.model)}</span><b>{tokens(m.counted)}</b></div>)}
          <div className="muted ub-note">최근 7일: {b.week.map(tokens).join(' · ')}. 이 PC 의 두레 에이전트만 셉니다 (다른 곳에서 쓴 Claude 는 들지 않습니다).</div>
        </div>
      )}
    </div>
  );
}
