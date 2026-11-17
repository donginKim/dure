import { SECTION_IDS, type ProjectViewPref, type RoleId, type SectionId } from '@shared/roles';
import type { Todo, Workspace } from '@shared/types';

export const ROLE_LABEL: Record<RoleId, string> = { developer: '개발자', planner: '기획자', lead: '팀장', designer: '디자이너', qa: 'QA' };
export const ROLE_HINT: Record<RoleId, string> = {
  developer: '워크스페이스와 TODO, 합치기와 자동 반영을 앞에 둡니다',
  planner: '진행 상황과 프로젝트 TODO, 정한 것(기억), 보고서 만들기를 앞에 둡니다',
  lead: '사람별 현황과 막힌 것, 사용량과 예산, 보고서 만들기를 앞에 둡니다',
  designer: 'TODO 와 워크스페이스, 약속(화면·API 형식), 만들기를 앞에 둡니다',
  qa: 'TODO 와 합치기, 자동 반영, 저장소의 확인 명령을 앞에 둡니다',
};
export const SECTION_LABEL: Record<SectionId, string> = {
  board: '전체 현황', repos: '저장소', workspaces: '워크스페이스', talk: '대화', agreements: '약속', autoship: '자동 반영', schedules: '예약',
  memory: '기억', makes: '만들기', plugins: '플러그인', merge: '합치기', todo: 'TODO', cleanup: '정리 대기', usage: '사용량',
};

/** 역할마다 앞에 보이는 칸 (순서대로). 여기에 없는 칸은 접어 둔다. */
export const ROLE_SECTIONS: Record<RoleId, SectionId[]> = {
  developer: ['workspaces', 'todo', 'merge', 'autoship', 'repos', 'talk', 'agreements', 'memory'],
  planner: ['board', 'todo', 'memory', 'makes', 'agreements', 'talk', 'schedules'],
  lead: ['board', 'todo', 'usage', 'makes', 'workspaces', 'talk', 'agreements'],
  designer: ['todo', 'workspaces', 'agreements', 'makes', 'talk', 'memory'],
  qa: ['todo', 'merge', 'autoship', 'repos', 'workspaces', 'agreements', 'talk'],
};

export interface RoleLayout { shown: SectionId[]; folded: SectionId[] }

/**
 * 현황 탭에 보일 칸과 접어 둘 칸. 역할을 고르지 않았으면 모든 칸이 원래 순서대로 보인다.
 * 사용자가 고친 구성이 있으면 그것을 쓴다. 시작에 꼭 필요한 칸은 접지 않는다:
 * 저장소가 없으면 저장소 칸을, 워크스페이스가 없으면 워크스페이스 칸을 맨 앞에 둔다 (거기에 "추가" 가 있다).
 */
export function layoutFor(pref: ProjectViewPref, ctx: { repos: number; workspaces: number }): RoleLayout {
  if (!pref.role) return { shown: [...SECTION_IDS], folded: [] };
  let shown = [...(pref.custom[pref.role] ?? ROLE_SECTIONS[pref.role])];
  const need: SectionId[] = [];
  if (ctx.repos === 0) need.push('repos');
  else if (ctx.workspaces === 0) need.push('workspaces');
  shown = [...need.filter((id) => !shown.includes(id)), ...shown];
  return { shown, folded: SECTION_IDS.filter((id) => !shown.includes(id)) };
}

/** 칸 고치기: 켜고 끄기, 위아래로 옮기기. 고친 구성(보이는 칸을 순서대로)을 돌려준다. */
export function toggleSection(shown: SectionId[], id: SectionId): SectionId[] {
  return shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
}
export function moveSection(shown: SectionId[], id: SectionId, dir: -1 | 1): SectionId[] {
  const i = shown.indexOf(id); const j = i + dir;
  if (i < 0 || j < 0 || j >= shown.length) return shown;
  const next = [...shown]; [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export interface RoleStat { label: string; value: string; hint: string; tone?: 'warn' | 'ok' }

/** 역할마다 맨 위에 보이는 숫자 넷. 이미 화면이 가진 것(TODO, 워크스페이스, 저장소)으로만 센다. */
export function roleStats(role: RoleId, d: { todos: Todo[]; workspaces: Workspace[]; repos: { verifyCommand?: string | null }[]; assigned: number }): RoleStat[] {
  const live = d.todos.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'done').length;
  const doing = live.filter((t) => t.status === 'doing').length;
  const left = live.filter((t) => t.status === 'todo').length;
  const mine = live.filter((t) => t.assignee === 'user' && t.status !== 'done').length;
  const pct = live.length ? Math.round((done / live.length) * 100) : 0;
  const working = d.workspaces.filter((w) => w.status === 'working').length;
  const waiting = d.workspaces.filter((w) => w.status === 'waiting_user').length;
  const verified = d.repos.filter((r) => r.verifyCommand).length;
  const S = {
    progress: { label: '진행률', value: live.length ? `${pct}%` : '—', hint: live.length ? `${live.length}개 중 ${done}개 완료` : 'TODO 가 아직 없습니다' },
    doing: { label: '하는 중', value: String(doing), hint: '지금 진행 중인 TODO' },
    left: { label: '남은 일', value: String(left), hint: '아직 시작하지 않은 TODO' },
    mine: { label: '내가 할 일', value: String(mine), hint: '사용자 몫으로 적힌 TODO 가운데 끝나지 않은 것', tone: mine > 0 ? 'warn' as const : undefined },
    working: { label: '일하는 에이전트', value: String(working), hint: `워크스페이스 ${d.workspaces.length}개 가운데` },
    waiting: { label: '내 답을 기다림', value: String(waiting), hint: '승인이나 답을 기다리며 멈춘 워크스페이스', tone: waiting > 0 ? 'warn' as const : undefined },
    done: { label: '끝난 일', value: String(done), hint: '완료된 TODO (확인해 볼 것)' },
    assigned: { label: '나눠 준 일', value: String(d.assigned), hint: '다른 사람의 두레에서 진행 중인 워크스페이스' },
    verify: { label: '확인 명령', value: `${verified}/${d.repos.length}`, hint: '확인 명령(시험·빌드)이 적힌 저장소', tone: d.repos.length > 0 && verified < d.repos.length ? 'warn' as const : verified > 0 ? 'ok' as const : undefined },
  };
  const pick: Record<RoleId, (keyof typeof S)[]> = {
    developer: ['working', 'waiting', 'doing', 'left'],
    planner: ['progress', 'doing', 'left', 'mine'],
    lead: ['progress', 'waiting', 'assigned', 'left'],
    designer: ['progress', 'mine', 'doing', 'left'],
    qa: ['verify', 'done', 'waiting', 'left'],
  };
  return pick[role].map((k) => S[k]);
}
