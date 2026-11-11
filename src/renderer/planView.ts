import type { PlanDecision, SpecFile } from '@shared/types';

/** 승인하면 만들어질 것의 수. */
export function planCounts(d: PlanDecision): { workspaces: number; todos: number } {
  return {
    workspaces: d.items.filter((i) => !i.existing).length,
    todos: d.items.reduce((n, i) => n + i.todos.filter((t) => t.title.trim()).length, 0) + d.projectTodos.filter((t) => t.title.trim()).length,
  };
}

/** 승인 버튼의 글. */
export function approveLabel(d: PlanDecision): string {
  const { workspaces, todos } = planCounts(d);
  const parts: string[] = [];
  if (workspaces) parts.push(`워크스페이스 ${workspaces}개`);
  if (todos) parts.push(`TODO ${todos}개`);
  return parts.length ? `승인하고 ${parts.join(', ')} 만들기` : '만들 것이 없습니다';
}

/** 지금 상태로 승인할 수 있는가. 안 되면 이유. */
export function planProblem(d: PlanDecision): string | null {
  const names = new Set<string>();
  for (const i of d.items) {
    const name = i.name.trim();
    if (!name) return '이름이 없는 워크스페이스가 있습니다.';
    if (names.has(name)) return `이름이 겹칩니다: ${name}`;
    names.add(name);
    // 기준 브랜치가 비어 있으면 그 저장소의 현재 브랜치에서 만든다.
    if (!i.existing && !i.repoId) return `"${name}" 의 저장소가 비어 있습니다.`;
  }
  const { workspaces, todos } = planCounts(d);
  return workspaces + todos === 0 ? '만들 것이 없습니다. 더하거나 거절하세요.' : null;
}

/** 빈 제목의 TODO 는 빼고, 앞뒤 공백을 다듬어 보낼 모양으로. */
export function tidyPlan(d: PlanDecision): PlanDecision {
  const todos = (list: PlanDecision['projectTodos']): PlanDecision['projectTodos'] => list.filter((t) => t.title.trim()).map((t) => ({ ...t, title: t.title.trim() }));
  return { items: d.items.map((i) => ({ ...i, name: i.name.trim(), role: i.role.trim(), todos: todos(i.todos) })), projectTodos: todos(d.projectTodos) };
}

/**
 * 고른 기획서 파일을 조율 에이전트에게 보낼 글로. 글 파일은 내용을 그대로 넣고, 아니면 경로만 준다 (에이전트가 직접 읽는다).
 * 파일 내용은 그대로 인용 블록에 넣는다: 어디까지가 기획서인지 에이전트가 알 수 있게.
 */
export function specMessage(spec: SpecFile): string {
  const head = `기획서 파일: ${spec.path}`;
  const ask = '이 기획서를 분석해서 계획안을 올려줘 (정리, 만들 워크스페이스, TODO). 내가 검토하고 승인한 뒤에 만들어져야 해.';
  if (spec.text === null) return `${head}\n\n이 파일을 읽어줘. ${ask}`;
  // 내용 안의 ``` 때문에 블록이 일찍 닫히지 않게, 더 긴 울타리를 쓴다.
  const longest = Math.max(2, ...(spec.text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${head}${spec.truncated ? ' (길어서 앞부분만 넣었다. 나머지는 파일을 직접 읽어라)' : ''}\n\n${fence}\n${spec.text}\n${fence}\n\n${ask}`;
}
