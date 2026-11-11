import type { ModelChoice } from '@shared/types';

/** Claude 계열 모델인가. 이름으로 가린다: Claude Code 가 알려 주는 목록에는 연결된 다른 회사의 모델도 섞여 있을 수 있다. */
export function isClaudeModel(m: Pick<ModelChoice, 'value' | 'name'>): boolean {
  return /claude|opus|sonnet|haiku|fable|mythos/i.test(`${m.value} ${m.name}`);
}
