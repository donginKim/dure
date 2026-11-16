import type { DailyDigest } from '@shared/types';

export const hm = (ms: number): string => { const m = Math.round(ms / 60_000); return m <= 0 ? '' : `${Math.floor(m / 60)}시간 ${m % 60}분`; };
export const tok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** 결산을 보고서 글(마크다운)로. 일일 보고나 주간 보고 초안으로 붙여 넣는다. */
export function reportText(d: DailyDigest): string {
  const [, m, day] = d.day.split('-').map(Number);
  const lines: string[] = [`## ${m}월 ${day}일 한 일`];
  const sum = [`TODO ${d.totals.done}개 완료`, d.totals.commits ? `커밋 ${d.totals.commits}` : '', d.totals.mains ? `main 반영 ${d.totals.mains}` : '', hm(d.totals.workMs) ? `근무 ${hm(d.totals.workMs)}` : ''].filter(Boolean);
  lines.push(sum.join(' · '), '');
  for (const p of d.projects) {
    if (p.done.length === 0 && p.commits === 0 && p.mains === 0) continue;
    lines.push(`### ${p.name}`);
    for (const t of p.done) lines.push(`- ${t.title}${t.workspace ? ` (${t.workspace})` : ''}`);
    const extra = [p.commits ? `커밋 ${p.commits}` : '', p.mains ? `main 반영 ${p.mains}` : ''].filter(Boolean).join(' · ');
    if (extra) lines.push(`- ${extra}`);
    lines.push('');
  }
  if (d.doing.length) { lines.push('### 이어서 할 일'); for (const t of d.doing.slice(0, 10)) lines.push(`- ${t.title}${t.project ? ` (${t.project})` : ''}`); lines.push(''); }
  return lines.join('\n').trim();
}
