import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaddyDay } from '@shared/types';
import { paddyStage, streakOf } from './Paddy';

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const LEVEL_NAME = ['한 일 없음', '조금', '보통', '많이', '아주 많이'];
const parse = (day: string): Date => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!); };
const CELL = 12; const GAP = 3; const STEP = CELL + GAP; const LEFT = 22; const TOP = 16;

/**
 * 잔디: 최근 1년, 하루 한 칸 (깃허브의 기여 그래프처럼 주가 세로 줄이고 월요일이 맨 위다).
 * 끝낸 TODO 1, 커밋 1, 기준 브랜치 반영 3 으로 센 점수가 클수록 짙다. 열 때 왼쪽부터 차례로 돋아나고,
 * 에이전트가 일하는 중이면 오늘 칸이 숨 쉰다 (움직임 줄이기 설정이면 멈춘다).
 * 칸을 누르면 그날을 본다. from~to 는 지금 현황판이 보고 있는 기간이다 (테두리로 표시한다).
 */
export function StewardGrass({ from, to, onPickDay }: { from: string; to: string; onPickDay: (day: string) => void }) {
  const [days, setDays] = useState<PaddyDay[] | null>(null);
  const [working, setWorking] = useState(false);
  const [hover, setHover] = useState<{ d: PaddyDay; x: number; y: number; right: boolean } | null>(null);
  /** 칸의 자리 (잔디 칸 안에서의 좌표): 말풍선을 그 위에 띄운다 */
  const at = (el: Element): { x: number; y: number; right: boolean } => {
    const box = scroll.current!.getBoundingClientRect(); const r = el.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top, right: r.left - box.left > box.width * 0.6 };
  };
  const scroll = useRef<HTMLDivElement>(null);
  /** 처음 그릴 때만 돋아나는 움직임을 준다 (자료가 바뀔 때마다 다시 돋지 않게) */
  const [sprout, setSprout] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      window.dure.projects.paddy(null).then((d) => { if (alive) setDays(d); }).catch(() => undefined);
      window.dure.projects.usageBar().then((u) => { if (alive) setWorking(u.working > 0); }).catch(() => undefined);
    };
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'todos' || topic === 'commit' || topic === 'workspaces') load(); });
    const t = setInterval(load, 60_000);
    return () => { alive = false; off(); clearInterval(t); };
  }, []);
  const loaded = days !== null;
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => setSprout(false), 2200);
    return () => clearTimeout(t);
  }, [loaded]);

  const grid = useMemo(() => {
    if (!days || days.length === 0) return null;
    // 월요일이 맨 위 (0), 일요일이 맨 아래 (6)
    const row = (date: string): number => (parse(date).getDay() + 6) % 7;
    const first = row(days[0]!.date);
    const cells = days.map((d, i) => ({ d, col: Math.floor((i + first) / 7), row: (i + first) % 7 }));
    const cols = cells[cells.length - 1]!.col + 1;
    // 달 이름: 그 달의 1일이 든 주 위에 적는다.
    const months = cells.filter((c) => c.d.date.endsWith('-01')).map((c) => ({ col: c.col, label: `${Number(c.d.date.slice(5, 7))}월` }));
    return { cells, cols, months };
  }, [days]);
  if (!days || !grid) return null;
  const today = days[days.length - 1]!;
  const active = days.filter((d) => d.score > 0).length;
  const total = days.reduce((n, d) => n + d.todos + d.commits, 0);
  const streak = streakOf(days);
  const width = LEFT + grid.cols * STEP; const height = TOP + 7 * STEP;
  const tip = (d: PaddyDay): string => `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))} (${WEEKDAY[parse(d.date).getDay()]}) · ${LEVEL_NAME[paddyStage(d.score)]} · 끝낸 일 ${d.todos} · 커밋 ${d.commits}${d.mains ? ` · 반영 ${d.mains}` : ''}`;

  return (
    <div className="sb-card grass">
      <div className="sb-card-head">
        <span>잔디</span>
        <span className="plan-hint">최근 1년 · 칸을 누르면 그날을 봅니다</span>
        <span className="spacer" />
        <span className="grass-stats">연속 <b>{streak}</b>일 · 일한 날 <b>{active}</b>일 · 끝낸 일과 커밋 <b>{total.toLocaleString('ko-KR')}</b>건</span>
      </div>
      <div className="grass-scroll" ref={scroll} onMouseLeave={() => setHover(null)}>
        {/* 칸의 크기는 화면 너비를 따른다: 1년이 가로로 다 보인다 */}
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: width * 1.5 }} className={sprout ? 'sprout' : ''} role="group" aria-label="최근 1년, 날마다 한 일">
          {grid.months.map((m) => <text key={`${m.col}${m.label}`} x={LEFT + m.col * STEP} y={10} className="grass-label">{m.label}</text>)}
          {[0, 2, 4].map((r) => <text key={r} x={0} y={TOP + r * STEP + CELL - 2} className="grass-label">{WEEKDAY[(r + 1) % 7]}</text>)}
          {grid.cells.map(({ d, col, row }) => {
            const lv = paddyStage(d.score);
            const picked = d.date >= from && d.date <= to;
            return (
              <rect
                key={d.date} x={LEFT + col * STEP} y={TOP + row * STEP} width={CELL} height={CELL} rx={3}
                className={`grass-cell l${lv}${picked ? ' picked' : ''}${d === today ? ' today' : ''}${d === today && working ? ' live' : ''}`}
                style={sprout ? { animationDelay: `${col * 22 + row * 14}ms` } : undefined}
                tabIndex={lv > 0 ? 0 : -1} role="button" aria-label={tip(d)}
                onMouseEnter={(e) => setHover({ d, ...at(e.currentTarget) })}
                onFocus={(e) => setHover({ d, ...at(e.currentTarget) })} onBlur={() => setHover(null)}
                onClick={() => onPickDay(d.date)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPickDay(d.date); } }}
              />
            );
          })}
        </svg>
        {hover && <span className={`sb-tip grass-tip${hover.right ? ' left' : ''}`} role="tooltip" style={{ left: hover.x, top: hover.y - 30 }}>{tip(hover.d)}</span>}
      </div>
      <div className="grass-legend">
        <span className="plan-hint">끝낸 TODO 1 · 커밋 1 · 기준 브랜치 반영 3 으로 셉니다</span>
        <span className="spacer" />
        <span>적게</span>
        {[0, 1, 2, 3, 4].map((lv) => <svg key={lv} width={CELL} height={CELL} aria-hidden="true"><rect width={CELL} height={CELL} rx={3} className={`grass-cell l${lv} still`} /></svg>)}
        <span>많이</span>
      </div>
    </div>
  );
}
