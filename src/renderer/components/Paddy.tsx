import { useEffect, useMemo, useState } from 'react';
import type { PaddyDay } from '@shared/types';

/** 점수 → 논의 단계: 0 빈 논, 1 모내기, 2 자란 벼, 3 이삭, 4 황금 벼 */
export const paddyStage = (score: number): number => (score <= 0 ? 0 : score <= 2 ? 1 : score <= 5 ? 2 : score <= 9 ? 3 : 4);
const STAGE_NAME = ['빈 논', '모내기', '자란 벼', '이삭 팬 벼', '황금 벼'];

/** 지금까지 이어진 날 수 (오늘이 비었으면 어제부터 센다) */
export function streakOf(days: PaddyDay[]): number {
  let i = days.length - 1;
  if (i >= 0 && days[i]!.score === 0) i--;
  let n = 0;
  for (; i >= 0 && days[i]!.score > 0; i--) n++;
  return n;
}

/**
 * 두레 논: 다랑이논. 한 달이 한 계단 논배미이고, 하루가 벼 한 포기다. 끝낸 TODO, 커밋, main 반영으로 벼가 자라 이삭이 패고 황금빛으로 익는다.
 * 계절마다 논의 빛이 바뀌고, 달마다 절기를 적는다.
 * 오늘 칸은 에이전트가 일하는 중이면 살랑거린다 (움직임 줄이기 설정이면 멈춘다).
 */
export function Paddy({ projectId, title = '두레 논' }: { projectId?: string; title?: string }) {
  const [days, setDays] = useState<PaddyDay[] | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      window.dure.projects.paddy(projectId ?? null).then((d) => { if (alive) setDays(d); }).catch(() => undefined);
      window.dure.projects.usageBar().then((u) => { if (alive) setWorking(u.working > 0); }).catch(() => undefined);
    };
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'todos' || topic === 'commit' || topic === 'workspaces') load(); });
    const t = setInterval(load, 60_000);
    return () => { alive = false; off(); clearInterval(t); };
  }, [projectId]);
  // 한 달 = 한 계단 (최근 12달, 오래된 달이 위). 하루 = 벼 한 포기.
  const months = useMemo(() => {
    if (!days) return [];
    const by = new Map<string, PaddyDay[]>();
    for (const d of days) { const k = d.date.slice(0, 7); by.set(k, [...(by.get(k) ?? []), d]); }
    return [...by.entries()].slice(-12).map(([key, list]) => ({ key, month: Number(key.slice(5)), list }));
  }, [days]);
  if (!days) return null;
  const year = days.reduce((n, d) => n + d.score, 0);
  const best = days.reduce((a, d) => (d.score > a.score ? d : a), days[0]!);
  const streak = streakOf(days);
  const today = days[days.length - 1]!;
  const ROW = 20; const STEP = 8; const LABEL = 30; const COL = 13;
  const width = LABEL + STEP * 11 + 31 * COL + 16;
  return (
    <div className="paddy">
      <div className="paddy-head">
        <b>{title}</b>
        <span className="muted">오늘 <b>{today.score}</b>단 · 연속 <b>{streak}</b>일 · 올해 <b>{year.toLocaleString('ko-KR')}</b>단</span>
      </div>
      <div className="paddy-scroll">
        <svg width={width} height={months.length * ROW + 8} role="img" aria-label={`${title}: 최근 12달, 날마다 한 일`}>
          {months.map((m, i) => {
            // 계단: 아래로 갈수록 한 칸씩 안으로 들어간다 (다랑이논)
            const x0 = LABEL + i * STEP; const y0 = i * ROW + 4;
            const w = m.list.length * COL + 10;
            return (
              <g key={m.key}>
                <text x={0} y={y0 + 13} className="paddy-month"><title>{TERMS[m.month - 1]}</title>{m.month}월</text>
                {/* 논배미: 물 댄 바닥과 아래쪽 논두렁 */}
                <rect x={x0} y={y0 + 2} width={w} height={ROW - 4} rx={6} className={`paddy-field ${SEASON[m.month - 1]}`} />
                {m.list.map((d, j) => (
                  <Plant key={d.date} x={x0 + 6 + j * COL} base={y0 + ROW - 4} d={d} live={d === today && working} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="paddy-legend muted">
        <span title="TODO 1 · 커밋 1 · main 반영 3단. 볏단은 main 에 반영한 날">끝낸 일만큼 벼가 자랍니다</span>
        <span className="grow" />
        <span>적게</span>{[0, 1, 2, 3, 4].map((st) => <svg key={st} width={14} height={22}><Plant x={2} base={20} d={{ date: '', todos: 0, commits: 0, mains: 0, score: [0, 1, 4, 7, 12][st]! }} live={false} legend /></svg>)}<span>많이</span>
      </div>
    </div>
  );
}

/** 24절기: 달마다 둘 */
const TERMS = ['소한·대한', '입춘·우수', '경칩·춘분', '청명·곡우', '입하·소만', '망종·하지', '소서·대서', '입추·처서', '백로·추분', '한로·상강', '입동·소설', '대설·동지'];
/** 달마다 논의 계절 빛 */
const SEASON = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

/** 벼 한 포기: 단계마다 키가 크고, 이삭이 패고, 황금빛으로 익어 고개를 숙인다. main 에 반영한 날은 볏단을 세운다. */
function Plant({ x, base, d, live, legend }: { x: number; base: number; d: PaddyDay; live: boolean; legend?: boolean }) {
  const st = paddyStage(d.score);
  const h = [0, 5, 8, 11, 13][st]!;
  const tip = base - h;
  return (
    <g className={`plant s${st}${live ? ' live' : ''}`}>
      {!legend && <title>{`${d.date.slice(5).replace('-', '/')} · ${STAGE_NAME[st]} · TODO ${d.todos} · 커밋 ${d.commits} · main 반영 ${d.mains}`}</title>}
      {st === 0 ? <circle cx={x + 3} cy={base - 1} r={1.6} className="plant-mud" /> : (
        <>
          <path d={`M${x + 3} ${base} L${x + 3} ${tip}`} className="plant-stem" />
          <path d={`M${x + 3} ${base - h * 0.35} Q${x - 1} ${base - h * 0.6} ${x - 1.5} ${base - h * 0.75}`} className="plant-leaf" />
          <path d={`M${x + 3} ${base - h * 0.5} Q${x + 7} ${base - h * 0.7} ${x + 7.5} ${base - h * 0.85}`} className="plant-leaf" />
          {st >= 3 && <path d={`M${x + 3} ${tip} Q${x + 7} ${tip - 1} ${x + 7.5} ${tip + (st === 4 ? 5 : 3)}`} className="plant-ear" />}
        </>
      )}
      {!legend && d.mains > 0 && <path d={`M${x} ${base - 2} L${x + 3} ${base - 9} L${x + 6} ${base - 2} M${x + 1} ${base - 5} H${x + 5}`} className="plant-sheaf" />}
    </g>
  );
}
