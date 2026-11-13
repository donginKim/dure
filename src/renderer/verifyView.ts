import type { VerifyState } from '@shared/types';

const ago = (at: number, now: number): string => {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
};

/** 워크스페이스의 확인 상태를 한 줄로. */
export function verifyLine(s: VerifyState, now: number): string {
  if (s.state === 'running') return '확인하는 중…';
  if (s.state === 'passed') return `확인 통과 · ${ago(s.at, now)}`;
  if (s.state === 'failed') return `확인 실패 · ${ago(s.at, now)} · 에이전트가 완료로 바꿀 수 없습니다`;
  return '아직 확인한 적이 없습니다 (에이전트가 TODO 를 완료로 바꿀 때 돌립니다)';
}
