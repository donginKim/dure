import { isNewRepoId, newRepoId, newRepoName, validRepoName } from '@shared/plan';
import type { AssignChoice, AssignItem, AssignmentOut, PlanDecision, PlanRepo, PlanTodo, ProposalItem, SpecFile } from '@shared/types';

/**
 * 검토 화면에서 고치는 중인 계획. 새 저장소는 이름이 아니라 바뀌지 않는 key 로 가리킨다:
 * 이름으로 이으면, 이름을 치는 도중 잠깐 다른 저장소와 같아질 때 그 저장소의 워크스페이스까지 따라온다.
 */
export interface DraftRepo extends PlanRepo { key: string }
export interface PlanDraft { newRepos: DraftRepo[]; items: ProposalItem[]; projectTodos: PlanTodo[] }
/** 고치는 중인 계획에서 새 저장소를 가리키는 저장소 id. 저장소 이름은 @ 로 시작할 수 없어 겹치지 않는다. */
export const draftRepoId = (key: string): string => newRepoId(`@${key}`);

export function toDraft(p: { newRepos: PlanRepo[]; items: ProposalItem[]; projectTodos: PlanTodo[] }): PlanDraft {
  const newRepos = p.newRepos.map((r, i) => ({ ...r, key: `r${i}` }));
  const byName = new Map(newRepos.map((r) => [newRepoId(r.name), draftRepoId(r.key)]));
  return { newRepos, items: p.items.map((it) => ({ ...it, repoId: byName.get(it.repoId) ?? it.repoId })), projectTodos: p.projectTodos };
}

/** 보낼 모양으로: key 를 지금의 이름으로 바꾼다. 빠진 저장소를 가리키면 빈 이름이 되어 planProblem 이 잡는다. */
export function fromDraft(d: PlanDraft): PlanDecision {
  const byKey = new Map(d.newRepos.map((r) => [draftRepoId(r.key), newRepoId(r.name.trim())]));
  return {
    newRepos: d.newRepos.map((r) => ({ name: r.name, description: r.description })),
    items: d.items.map((it) => (isNewRepoId(it.repoId) ? { ...it, repoId: byKey.get(it.repoId) ?? newRepoId('') } : it)),
    projectTodos: d.projectTodos,
  };
}

/** 승인하면 내 PC 에 만들어질 것의 수와, 다른 사람에게 나눠 줄 워크스페이스의 수 (handed). 나눠 주는 것은 그 사람이 수락해야 만들어진다. */
export function planCounts(d: PlanDecision): { repos: number; workspaces: number; todos: number; handed: number } {
  const mine = d.items.filter((i) => !i.owner);
  return {
    repos: d.newRepos?.length ?? 0,
    workspaces: mine.filter((i) => !i.existing).length,
    todos: mine.reduce((n, i) => n + i.todos.filter((t) => t.title.trim()).length, 0) + d.projectTodos.filter((t) => t.title.trim()).length,
    handed: d.items.length - mine.length,
  };
}

/** 승인 버튼의 글. */
export function approveLabel(d: PlanDecision): string {
  const { repos, workspaces, todos, handed } = planCounts(d);
  const parts: string[] = [];
  if (repos) parts.push(`저장소 ${repos}개`);
  if (workspaces) parts.push(`워크스페이스 ${workspaces}개`);
  if (todos) parts.push(`TODO ${todos}개`);
  if (parts.length === 0) return handed ? `승인하고 워크스페이스 ${handed}개 나눠 주기` : '만들 것이 없습니다';
  return `승인하고 ${parts.join(', ')} 만들기${handed ? `, ${handed}개 나눠 주기` : ''}`;
}

/** 지금 상태로 승인할 수 있는가. 안 되면 이유. */
export function planProblem(d: PlanDecision): string | null {
  const repoNames = new Set<string>();
  for (const r of d.newRepos ?? []) {
    if (!validRepoName(r.name.trim())) return `새 저장소 이름 "${r.name}": 영문, 숫자, . _ - 만 쓸 수 있습니다.`;
    if (repoNames.has(r.name.trim().toLowerCase())) return `새 저장소 이름이 겹칩니다: ${r.name}`;
    repoNames.add(r.name.trim().toLowerCase());
  }
  const names = new Set<string>();
  for (const i of d.items) {
    const name = i.name.trim();
    if (!name) return '이름이 없는 워크스페이스가 있습니다.';
    if (names.has(name)) return `이름이 겹칩니다: ${name}`;
    names.add(name);
    // 기준 브랜치가 비어 있으면 그 저장소의 현재 브랜치에서 만든다.
    // 다른 사람에게 나눠 주는 것은 저장소를 그 사람이 고른다.
    if (i.owner) continue;
    if (!i.existing && !i.repoId) return `"${name}" 의 저장소가 비어 있습니다.`;
    if (!i.existing && isNewRepoId(i.repoId) && !repoNames.has(newRepoName(i.repoId).toLowerCase())) return `"${name}" 의 저장소 "${newRepoName(i.repoId)}" 가 새 저장소 목록에 없습니다. 저장소를 다시 고르세요.`.replace('저장소 "" 가', '저장소가');
  }
  const { repos, workspaces, todos, handed } = planCounts(d);
  return repos + workspaces + todos + handed === 0 ? '만들 것이 없습니다. 더하거나 거절하세요.' : null;
}

/** 빈 제목의 TODO 는 빼고, 앞뒤 공백을 다듬어 보낼 모양으로. */
export function tidyPlan(d: PlanDecision): PlanDecision {
  const todos = (list: PlanDecision['projectTodos']): PlanDecision['projectTodos'] => list.filter((t) => t.title.trim()).map((t) => ({ ...t, title: t.title.trim() }));
  return { newRepos: (d.newRepos ?? []).map((r) => ({ name: r.name.trim(), description: r.description.trim() })), items: d.items.map((i) => ({ ...i, name: i.name.trim(), role: i.role.trim(), todos: todos(i.todos) })), projectTodos: todos(d.projectTodos) };
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

export const ASSIGN_STATE_LABEL: Record<AssignmentOut['state'], string> = { sent: '수락 대기', accepted: '수락함', declined: '거절함' };

/** 나눠 준 일 한 줄: 얼마나 됐는지. */
export function assignProgressLine(a: AssignmentOut): string {
  if (a.state === 'sent') return '그 사람이 수락해야 만들어집니다';
  if (a.state === 'declined') return a.note ? `거절: ${a.note}` : '거절했습니다';
  const todos = a.progress.flatMap((w) => w.todos).filter((t) => t.status !== 'cancelled');
  if (a.progress.length === 0) return '진행 상황을 공개하지 않았습니다';
  return todos.length ? `TODO ${todos.filter((t) => t.status === 'done').length}/${todos.length} 끝남` : 'TODO 없음';
}

/** 받은 배정을 지금 고른 대로 수락할 수 있는가. 안 되면 이유. */
export function assignChoiceProblem(items: AssignItem[], choices: AssignChoice[]): string | null {
  const names = new Set<string>();
  for (const [i, it] of items.entries()) {
    const c = choices[i];
    const name = (c?.name ?? it.name).trim();
    if (!name) return '이름이 없는 워크스페이스가 있습니다.';
    if (names.has(name)) return `이름이 겹칩니다: ${name}`;
    names.add(name);
    if (!c?.repoId && !c?.newRepo?.trim()) return `"${name}" 을(를) 만들 저장소를 고르거나 새 저장소의 이름을 적으세요.`;
    if (!c.repoId && !validRepoName(c.newRepo!.trim())) return `새 저장소 이름 "${c.newRepo}": 영문, 숫자, . _ - 만 쓸 수 있습니다.`;
  }
  return null;
}
