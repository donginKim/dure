/**
 * 프로젝트에서의 내 역할. 보기 설정일 뿐이다: 현황 탭에 어느 칸을 어떤 순서로 보일지를 정한다.
 * (함께하는 프로젝트의 리더·참여자·관찰자는 권한이고, 이것과는 따로다. 역할을 바꿔도 할 수 있는 일은 그대로다.)
 */
export const ROLE_IDS = ['developer', 'planner', 'lead', 'designer', 'qa'] as const;
export type RoleId = typeof ROLE_IDS[number];

/** 현황 탭의 칸 */
export const SECTION_IDS = ['board', 'repos', 'workspaces', 'talk', 'agreements', 'autoship', 'schedules', 'memory', 'makes', 'plugins', 'merge', 'todo', 'cleanup', 'usage'] as const;
export type SectionId = typeof SECTION_IDS[number];

/** 프로젝트의 보기 설정: 고른 역할('' 이면 고르지 않음: 모든 칸)과, 역할마다 사용자가 고친 칸 구성(보이는 칸을 순서대로) */
export interface ProjectViewPref { role: RoleId | ''; custom: Partial<Record<RoleId, SectionId[]>> }

export const isRole = (v: unknown): v is RoleId => typeof v === 'string' && (ROLE_IDS as readonly string[]).includes(v);
export const isSection = (v: unknown): v is SectionId => typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);

/** 저장하거나 읽을 때 모양을 다듬는다: 모르는 역할·칸은 버리고, 겹친 칸은 한 번만. */
export function cleanViewPref(role: unknown, custom: unknown): ProjectViewPref {
  const out: ProjectViewPref = { role: isRole(role) ? role : '', custom: {} };
  if (typeof custom === 'object' && custom !== null && !Array.isArray(custom)) {
    for (const [k, v] of Object.entries(custom)) {
      if (!isRole(k) || !Array.isArray(v)) continue;
      out.custom[k] = [...new Set(v.filter(isSection))];
    }
  }
  return out;
}
