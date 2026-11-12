import type { TokenCount } from '@shared/types';

/** 토큰 수를 읽기 쉽게: 1,234 / 12.3천 / 1.2백만 */
export function tokens(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}천`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}백만`;
}
/** 모델에 들어간 것 전부 (새로 읽은 것과 캐시) */
export const inputAll = (c: TokenCount): number => c.input + c.cacheWrite + c.cacheRead;
/** 전체에서 차지하는 몫 (막대의 길이, 0~100) */
export function share(part: TokenCount, total: TokenCount): number {
  const t = inputAll(total) + total.output;
  return t === 0 ? 0 : Math.round(((inputAll(part) + part.output) / t) * 100);
}
