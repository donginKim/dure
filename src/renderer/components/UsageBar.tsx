import { useEffect, useRef, useState } from 'react';
import type { UsageBar as Bar } from '@shared/types';
import { Companion } from './Companion';

export const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const hhmm = (sec: number): string => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const KIND: Record<string, string> = { five_hour: '5시간', seven_day: '7일', seven_day_opus: '7일 (Opus)', seven_day_sonnet: '7일 (Sonnet)' };
const whenText = (sec: number): string => { const d = new Date(sec * 1000); const today = new Date(); return d.toDateString() === today.toDateString() ? hhmm(sec) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(sec)}`; };
/** 남은 시간을 사람 말로 */
const left = (ms: number): string => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 1 ? '곧' : m < 60 ? `${m}분` : m < 1440 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간`; };
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
export function UsageBar({ onOpenAttention }: { onOpenAttention: () => void }) {
  const [b, setB] = useState<Bar | null>(null);
  const [open, setOpen] = useState(false);
  const [companion, setCompanion] = useState(false);
  useEffect(() => {
    const load = (): void => { window.dure.settings.get().then((s) => setCompanion(s.companion)).catch(() => undefined); };
    load();
    return window.dure.onChanged((topic) => { if (topic === 'settings') load(); });
  }, []);
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
  // 가장 빠듯한 한도 창 (사용률이 가장 높은 것)
  const w0 = b.windows[0];
  const leftPct = (w: Bar['windows'][number]): number => Math.max(0, 100 - Math.round(w.utilization * 100));
  const windowText = (w: Bar['windows'][number]): string => `${KIND[w.kind] ?? w.kind} 한도 ${Math.round(w.utilization * 100)}% 씀 · ${leftPct(w)}% 남음${w.resetsAt ? ` · ${whenText(w.resetsAt)} 초기화` : ''}`;
  const etaText = (w: Bar['windows'][number]): string | null => (w.utilization >= 1 ? '한도에 걸림' : w.eta ? `이 속도면 ${left(w.eta - Date.now())} 뒤 한도` : null);
  const limText = lim
    ? `${lim.status === 'rejected' ? '한도 걸림' : lim.status === 'warning' ? '한도 가까움' : '한도 여유'}${lim.kind ? ` (${KIND[lim.kind] ?? lim.kind})` : ''}${lim.utilization !== null ? ` ${Math.round(lim.utilization * (lim.utilization <= 1 ? 100 : 1))}%` : ''}${lim.resetsAt ? ` · ${hhmm(lim.resetsAt)} 풀림` : ''}`
    : '';
  return (
    <div className="statusbar" ref={box}>
      <button className="ub-main" onClick={() => setOpen((v) => !v)} title="이 PC 의 두레 에이전트가 오늘 쓴 토큰입니다 (입력 + 캐시 쓰기 + 출력. 캐시에서 읽은 것은 따로). 누르면 프로젝트·모델별로 봅니다">
        <span className={`dot ${b.working ? 'working' : 'idle'}`} />
        <span>{b.working ? <>일하는 에이전트 <b>{b.working}</b></> : '쉬는 중'}</span>
        <span className="ub-sep" />
        <span>오늘 <b>{tokens(b.today.counted)}</b> 토큰</span>
        <Spark week={b.week} />
        <span className="ub-sep" />
        {w0
          ? <span className={`ub-limit ${w0.utilization >= 1 ? 'rejected' : w0.utilization >= 0.8 || (w0.eta && w0.eta - Date.now() < 2 * 3_600_000) ? 'warning' : 'allowed'}`} title={`${windowText(w0)}. 누르면 자세히 봅니다`}>
              {KIND[w0.kind] ?? w0.kind} 한도 <b>{leftPct(w0)}% 남음</b>{etaText(w0) ? ` · ${etaText(w0)}` : ''}
            </span>
          : lim ? <span className={`ub-limit ${lim.status}`}>{limText}</span>
            : <span className="muted" title="채팅 방식의 에이전트가 한 번 일하면 Claude 계정의 한도를 받아 옵니다">한도 —</span>}
      </button>
      {companion && <Companion onOpenAttention={onOpenAttention} limitHot={!!w0 && (w0.utilization >= 0.8 || (!!w0.eta && w0.eta - Date.now() < 2 * 3_600_000))} />}
      {open && (
        <div className="ub-pop" role="dialog" aria-label="오늘 사용량">
          {b.windows.length > 0 && (
            <>
              <div className="ub-pop-head">Claude 계정의 사용 한도 <span className="muted">(막대는 쓴 만큼)</span></div>
              {b.windows.map((w) => (
                <div key={w.kind} className="ub-row">
                  <span className="grow">{KIND[w.kind] ?? w.kind}{w.resetsAt ? <span className="muted"> · {whenText(w.resetsAt)} 초기화</span> : null}</span>
                  <span className={`ub-barwrap lim${w.utilization >= 0.8 ? ' hot' : ''}`}><span style={{ width: `${Math.min(100, Math.round(w.utilization * 100))}%` }} /></span>
                  <b title={`${Math.round(w.utilization * 100)}% 씀`}>{leftPct(w)}% 남음</b>
                </div>
              ))}
              {b.windows.some((w) => w.eta) && <div className="muted ub-note">{b.windows.filter((w) => w.eta).map((w) => `${KIND[w.kind] ?? w.kind}: ${etaText(w)}`).join(' · ')} (최근 1시간의 속도로 어림한 것입니다)</div>}
              {!b.windows.some((w) => w.eta) && <div className="muted ub-note">지금 속도로는 초기화 전에 한도에 닿지 않습니다 (최근 1시간 기준).</div>}
              <div style={{ height: 6 }} />
            </>
          )}
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
