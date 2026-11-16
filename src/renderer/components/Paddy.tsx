import { useEffect, useMemo, useState } from 'react';
import type { PaddyDay } from '@shared/types';

/** 점수 → 논의 단계: 0 빈 논, 1 모내기, 2 자란 벼, 3 이삭, 4 황금 벼 */
export const paddyStage = (score: number): number => (score <= 0 ? 0 : score <= 2 ? 1 : score <= 5 ? 2 : score <= 9 ? 3 : 4);
const STAGE_NAME = ['빈 논', '모내기', '자란 벼', '이삭 팬 벼', '황금 벼'];
const MONTH = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

/** 지금까지 이어진 날 수 (오늘이 비었으면 어제부터 센다) */
export function streakOf(days: PaddyDay[]): number {
  let i = days.length - 1;
  if (i >= 0 && days[i]!.score === 0) i--;
  let n = 0;
  for (; i >= 0 && days[i]!.score > 0; i--) n++;
  return n;
}

/**
 * 두레 논: 깃허브 잔디처럼 하루 한 칸. 끝낸 TODO, 커밋, main 반영으로 벼가 자란다.
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
  const weeks = useMemo(() => {
    if (!days) return [];
    // 첫 칸을 그 주의 일요일에 맞춘다
    const first = new Date(`${days[0]!.date}T12:00:00`).getDay();
    const cells: (PaddyDay | null)[] = [...Array(first).fill(null), ...days];
    const out: (PaddyDay | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [days]);
  if (!days) return null;
  const year = days.reduce((n, d) => n + d.score, 0);
  const best = days.reduce((a, d) => (d.score > a.score ? d : a), days[0]!);
  const streak = streakOf(days);
  const today = days[days.length - 1]!;
  const C = 11; const G = 3;
  return (
    <div className="paddy">
      <div className="paddy-head">
        <b>{title}</b>
        <span className="muted">올해 수확 <b>{year.toLocaleString('ko-KR')}</b>단</span>
        <span className="muted">연속 <b>{streak}</b>일 모내기</span>
        {best.score > 0 && <span className="muted">가장 많이 한 날 {best.date.slice(5).replace('-', '/')} ({best.score}단)</span>}
        <span className="muted">오늘 {today.score}단</span>
      </div>
      <div className="paddy-scroll">
        <svg width={weeks.length * (C + G) + 24} height={7 * (C + G) + 16} role="img" aria-label={`${title}: 최근 1년 동안 날마다 한 일`}>
          {weeks.map((w, i) => {
            const firstDay = w.find((d) => d);
            const showMonth = firstDay && Number(firstDay.date.slice(8)) <= 7;
            return showMonth ? <text key={`m${i}`} x={24 + i * (C + G)} y={9} className="paddy-month">{MONTH[Number(firstDay!.date.slice(5, 7)) - 1]}</text> : null;
          })}
          {['', '월', '', '수', '', '금', ''].map((l, r) => (l ? <text key={`d${r}`} x={0} y={16 + r * (C + G) + 9} className="paddy-month">{l}</text> : null))}
          {weeks.map((w, i) => w.map((d, r) => (d ? (
            <rect key={d.date} x={24 + i * (C + G)} y={16 + r * (C + G)} width={C} height={C} rx={2}
              className={`paddy-cell s${paddyStage(d.score)}${d === today && working ? ' live' : ''}`}>
              <title>{`${d.date.slice(5).replace('-', '/')} · ${STAGE_NAME[paddyStage(d.score)]} · TODO ${d.todos} · 커밋 ${d.commits} · main 반영 ${d.mains}`}</title>
            </rect>
          ) : null)))}
        </svg>
      </div>
      <div className="paddy-legend muted">
        <span>TODO 1 · 커밋 1 · main 반영 3단</span>
        <span className="grow" />
        <span>적게</span>{[0, 1, 2, 3, 4].map((s) => <svg key={s} width={C} height={C}><rect width={C} height={C} rx={2} className={`paddy-cell s${s}`} /></svg>)}<span>많이</span>
      </div>
    </div>
  );
}
