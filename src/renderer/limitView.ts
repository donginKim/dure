import type { LimitInfo } from '@shared/types';

const KIND: Record<string, string> = {
  five_hour: '5시간 한도', seven_day: '주간 한도', seven_day_opus: 'Opus 주간 한도', seven_day_sonnet: 'Sonnet 주간 한도', overage: '추가 사용 한도', seven_day_overage_included: '주간 한도',
};

const hhmm = (sec: number): string => {
  const d = new Date(sec * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const day = new Date().toDateString() === d.toDateString() ? '' : `${d.getMonth() + 1}/${d.getDate()} `;
  return `${day}${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** 한도 띠에 보일 한 줄. */
export function limitText(l: LimitInfo, _now: number): string {
  const what = KIND[l.kind] ?? '사용 한도';
  const when = l.resetsAt ? ` (${hhmm(l.resetsAt)} 에 풀립니다)` : '';
  if (l.status === 'rejected') return `${what}에 걸려 멈췄습니다${when}. 다른 모델로 바꾸면 대화를 끊지 않고 이어 갈 수 있습니다.`;
  const pct = l.utilization !== null ? ` ${Math.round(l.utilization * (l.utilization <= 1 ? 100 : 1))}%` : '';
  return `${what}에 가까워졌습니다${pct}${when}.`;
}
