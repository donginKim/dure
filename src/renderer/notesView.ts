/** 메모 목록에 보일 시각: 오늘이면 시:분, 올해면 월/일, 아니면 연/월/일. */
export function noteTime(at: number, now = Date.now()): string {
  const d = new Date(at); const n = new Date(now);
  const two = (x: number): string => String(x).padStart(2, '0');
  if (d.toDateString() === n.toDateString()) return `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 제목이 비어 있으면 본문의 첫 줄을 제목 자리에 보인다. */
export function noteHeading(title: string, preview: string): string {
  return title.trim() || preview.trim().slice(0, 40) || '새 메모';
}

/** 찾은 낱말을 표시할 수 있게 글을 조각으로 나눈다 (대소문자를 가리지 않는다). */
export function markMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const words = query.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 0 || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    let best = -1; let len = 0;
    for (const w of words) {
      const at = lower.indexOf(w, i);
      if (at >= 0 && (best < 0 || at < best || (at === best && w.length > len))) { best = at; len = w.length; }
    }
    if (best < 0) { out.push({ text: text.slice(i), hit: false }); break; }
    if (best > i) out.push({ text: text.slice(i, best), hit: false });
    out.push({ text: text.slice(best, best + len), hit: true });
    i = best + len;
  }
  return out;
}
