import type { WorkDay, WorkStatus } from '@shared/types';

/** 걸린 시간을 "8시간 12분" 꼴로. 1분이 안 되면 "1분 미만". */
export function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '1분 미만';
  const h = Math.floor(m / 60);
  return h ? `${h}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`;
}
const two = (n: number): string => String(n).padStart(2, '0');
/** 시각을 "09:02" 꼴로 */
export const hhmm = (at: number): string => { const d = new Date(at); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
export const dayKey = (y: number, m: number, d: number): string => `${y}-${two(m)}-${two(d)}`;

export interface Cell { day: number | null; key: string; data: WorkDay | null; weekend: boolean }
/**
 * 달력 한 달치의 칸 (일요일부터). 그 달이 아닌 칸은 day 가 null 이다. month 는 1~12.
 * 주 단위로 꽉 채운다 (5주나 6주).
 */
export function monthGrid(year: number, month: number, days: WorkDay[]): Cell[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const first = new Date(year, month - 1, 1).getDay();
  const count = new Date(year, month, 0).getDate();
  const cells: Cell[] = [];
  for (let i = 0; i < first; i += 1) cells.push({ day: null, key: `b${i}`, data: null, weekend: false });
  for (let d = 1; d <= count; d += 1) {
    const key = dayKey(year, month, d);
    const dow = (first + d - 1) % 7;
    cells.push({ day: d, key, data: byDay.get(key) ?? null, weekend: dow === 0 || dow === 6 });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, key: `a${cells.length}`, data: null, weekend: false });
  return cells;
}

/** 휴게 시간을 "1시간 30분" 꼴로 (분) */
export const breakLabel = (min: number): string => duration(min * 60_000);
/** 입력한 글을 분으로: "90", "1:30", "1시간 30분", "1.5시간" 을 받는다. 알 수 없으면 null */
export function parseBreak(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):(\d{1,2})$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d+(?:\.\d+)?)\s*시간(?:\s*(\d+)\s*분)?$/.exec(t))) return Math.round(Number(m[1]) * 60) + Number(m[2] ?? 0);
  if ((m = /^(\d+)\s*분?$/.exec(t))) return Number(m[1]);
  return null;
}

/** 그 달의 합: 근무한 날 수와 시간 */
export function monthTotal(days: WorkDay[]): { days: number; ms: number } {
  return { days: days.filter((d) => d.totalMs > 0).length, ms: days.reduce((n, d) => n + d.totalMs, 0) };
}

/** 창 구석의 근무 표시에 적을 글. 근무 중이 아니면 null (표시하지 않는다). */
export function workBadge(s: Pick<WorkStatus, 'enabled' | 'unit' | 'openSession' | 'atWork' | 'todayMs'>): string | null {
  if (!s.enabled) return null;
  const working = s.unit === 'half' ? s.openSession !== null : s.atWork;
  if (!working) return null;
  return `근무 중 · ${s.todayMs >= 60_000 ? duration(s.todayMs) : '0분'}`;
}
