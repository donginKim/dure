import { cleanViewPref, ROLE_IDS, SECTION_IDS } from '@shared/roles';
import type { Todo, Workspace } from '@shared/types';
import { layoutFor, moveSection, ROLE_LABEL, ROLE_SECTIONS, roleStats, SECTION_LABEL, toggleSection } from '../../src/renderer/roleView';

const todo = (status: string, assignee = 'agent'): Todo => ({ status, assignee } as unknown as Todo);
const ws = (status: string): Workspace => ({ status } as unknown as Workspace);

test('역할 다섯과 칸마다 이름이 있고, 역할의 구성은 아는 칸으로만 겹치지 않게 짜여 있다', () => {
  expect(ROLE_IDS).toEqual(['developer', 'planner', 'lead', 'designer', 'qa']);
  for (const r of ROLE_IDS) {
    expect(ROLE_LABEL[r]).toBeTruthy();
    expect(new Set(ROLE_SECTIONS[r]).size).toBe(ROLE_SECTIONS[r].length);
    for (const id of ROLE_SECTIONS[r]) expect(SECTION_IDS).toContain(id);
    expect(ROLE_SECTIONS[r]).toContain('todo');
  }
  for (const id of SECTION_IDS) expect(SECTION_LABEL[id]).toBeTruthy();
});

test('layoutFor: 역할을 고르지 않으면 모든 칸, 고르면 그 역할의 칸이 앞에 오고 나머지는 접힌다', () => {
  const ctx = { repos: 1, workspaces: 2 };
  expect(layoutFor({ role: '', custom: {} }, ctx)).toEqual({ shown: [...SECTION_IDS], folded: [] });
  const dev = layoutFor({ role: 'developer', custom: {} }, ctx);
  expect(dev.shown.slice(0, 3)).toEqual(['workspaces', 'todo', 'merge']);
  expect(dev.folded).toContain('makes');
  expect([...dev.shown, ...dev.folded].sort()).toEqual([...SECTION_IDS].sort());
  const plan = layoutFor({ role: 'planner', custom: {} }, ctx);
  expect(plan.shown[0]).toBe('board');
  expect(plan.folded).toEqual(expect.arrayContaining(['merge', 'autoship', 'repos']));
  // 사용자가 고친 구성이 있으면 그것을 쓴다 (그 역할에서만)
  const custom = { planner: ['todo', 'usage'] as const };
  expect(layoutFor({ role: 'planner', custom: { planner: [...custom.planner] } }, ctx).shown).toEqual(['todo', 'usage']);
  expect(layoutFor({ role: 'qa', custom: { planner: [...custom.planner] } }, ctx).shown).toEqual(ROLE_SECTIONS.qa);
});

test('layoutFor: 시작에 필요한 칸은 접지 않는다 (저장소가 없으면 저장소, 워크스페이스가 없으면 워크스페이스)', () => {
  expect(layoutFor({ role: 'planner', custom: {} }, { repos: 0, workspaces: 0 }).shown[0]).toBe('repos');
  expect(layoutFor({ role: 'planner', custom: {} }, { repos: 1, workspaces: 0 }).shown[0]).toBe('workspaces');
  expect(layoutFor({ role: 'planner', custom: {} }, { repos: 1, workspaces: 1 }).shown).not.toContain('repos');
  expect(layoutFor({ role: 'planner', custom: { planner: [] } }, { repos: 0, workspaces: 0 }).shown).toEqual(['repos']);
});

test('칸 고치기: 켜고 끄기, 위아래로 옮기기', () => {
  expect(toggleSection(['todo', 'merge'], 'merge')).toEqual(['todo']);
  expect(toggleSection(['todo'], 'usage')).toEqual(['todo', 'usage']);
  expect(moveSection(['todo', 'merge', 'usage'], 'merge', -1)).toEqual(['merge', 'todo', 'usage']);
  expect(moveSection(['todo', 'merge', 'usage'], 'merge', 1)).toEqual(['todo', 'usage', 'merge']);
  expect(moveSection(['todo', 'merge'], 'todo', -1)).toEqual(['todo', 'merge']);
  expect(moveSection(['todo', 'merge'], 'board', 1)).toEqual(['todo', 'merge']);
});

test('roleStats: 역할마다 다른 숫자 넷을 보인다 (취소한 일은 세지 않는다)', () => {
  const d = {
    todos: [todo('done'), todo('done'), todo('doing'), todo('todo'), todo('todo', 'user'), todo('cancelled')],
    workspaces: [ws('working'), ws('waiting_user'), ws('idle')], repos: [{ verifyCommand: 'pnpm test' }, { verifyCommand: '' }], assigned: 2,
  };
  expect(roleStats('planner', d).map((s) => `${s.label}=${s.value}`)).toEqual(['진행률=40%', '하는 중=1', '남은 일=2', '내가 할 일=1']);
  expect(roleStats('developer', d).map((s) => `${s.label}=${s.value}`)).toEqual(['일하는 에이전트=1', '내 답을 기다림=1', '하는 중=1', '남은 일=2']);
  expect(roleStats('lead', d).map((s) => `${s.label}=${s.value}`)).toEqual(['진행률=40%', '내 답을 기다림=1', '나눠 준 일=2', '남은 일=2']);
  expect(roleStats('qa', d).map((s) => `${s.label}=${s.value}`)).toEqual(['확인 명령=1/2', '끝난 일=2', '내 답을 기다림=1', '남은 일=2']);
  expect(roleStats('designer', d)).toHaveLength(4);
  expect(roleStats('developer', d)[1]!.tone).toBe('warn');
  expect(roleStats('planner', { todos: [], workspaces: [], repos: [], assigned: 0 })[0]).toMatchObject({ value: '—' });
});

test('cleanViewPref: 모르는 역할과 칸은 버린다', () => {
  expect(cleanViewPref('qa', { qa: ['todo', 'nope', 'todo', 'merge'], hacker: ['todo'], planner: 'x' })).toEqual({ role: 'qa', custom: { qa: ['todo', 'merge'] } });
  expect(cleanViewPref('boss', null)).toEqual({ role: '', custom: {} });
  expect(cleanViewPref('', [])).toEqual({ role: '', custom: {} });
});
