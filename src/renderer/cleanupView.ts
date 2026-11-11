import type { CompletionChoice, CompletionPlan } from '@shared/types';

/** 바이트 수를 사람이 읽는 크기로. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

type PlanWorkspace = CompletionPlan['workspaces'][number];

/** 이 작업 폴더를 지우면 잃는 것이 있는가. 커밋하지 않은 변경은 지우면 돌아오지 않는다. */
export function worktreeRisk(w: PlanWorkspace): string | null {
  if (!w.exists) return null;
  if (w.uncommitted > 0) return `커밋하지 않은 변경 ${w.uncommitted}건이 함께 지워집니다`;
  if (w.unpushed === null) return '이 브랜치는 원격에 없습니다. 커밋은 이 PC 의 저장소에만 남습니다';
  if (w.unpushed > 0) return `push 하지 않은 커밋 ${w.unpushed}건이 있습니다. 커밋은 이 PC 의 저장소에 남습니다`;
  return null;
}

/**
 * 완료 처리 창이 처음에 체크해 둘 것.
 * 정리 대기는 전부 체크, 작업 폴더는 커밋하지 않은 변경이 없는 것만 체크한다: 지우면 돌아오지 않는 것을 기본으로 고르지 않는다.
 */
export function defaultChoice(plan: CompletionPlan): CompletionChoice {
  return {
    removeWorktrees: plan.workspaces.filter((w) => w.exists && w.uncommitted === 0).map((w) => w.id),
    removeItems: plan.items.map((i) => i.id),
  };
}

/** 완료 처리 버튼 옆에 보일 요약. */
export function choiceSummary(plan: CompletionPlan, choice: CompletionChoice): string {
  const folders = plan.workspaces.filter((w) => choice.removeWorktrees.includes(w.id)).length;
  const items = plan.items.filter((i) => choice.removeItems.includes(i.id));
  const bytes = items.reduce((n, i) => n + i.size, 0);
  const parts: string[] = [];
  if (folders) parts.push(`작업 폴더 ${folders}개`);
  if (items.length) parts.push(`정리 대기 ${items.length}건 (${formatBytes(bytes)})`);
  return parts.length ? `${parts.join(', ')}을(를) 지웁니다` : '아무것도 지우지 않습니다';
}
