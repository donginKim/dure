import type { PlanDecision, ProposalItem } from '@shared/types';
import { approveLabel, planCounts, planProblem, specMessage, tidyPlan } from '../../src/renderer/planView';

const item = (o: Partial<ProposalItem> = {}): ProposalItem => ({ name: '로그인 화면', repoId: 'r1', baseBranch: 'main', role: '', todos: [], existing: false, ...o });
const todo = (title: string, assignee: 'agent' | 'user' = 'agent') => ({ title, detail: '', assignee });

test('planCounts 와 approveLabel: 새로 만들 워크스페이스와 제목이 있는 TODO 만 센다', () => {
  const d: PlanDecision = { items: [item({ todos: [todo('폼'), todo(' ')] }), item({ name: '이미 있던 것', existing: true, todos: [todo('고치기')] })], projectTodos: [todo('결정', 'user')] };
  expect(planCounts(d)).toEqual({ workspaces: 1, todos: 3 });
  expect(approveLabel(d)).toBe('승인하고 워크스페이스 1개, TODO 3개 만들기');
  expect(approveLabel({ items: [], projectTodos: [todo('결정')] })).toBe('승인하고 TODO 1개 만들기');
  expect(approveLabel({ items: [], projectTodos: [] })).toBe('만들 것이 없습니다');
});

test('planProblem: 빈 이름, 겹친 이름, 빈 저장소, 만들 것이 없음', () => {
  expect(planProblem({ items: [item()], projectTodos: [] })).toBeNull();
  expect(planProblem({ items: [item({ name: ' ' })], projectTodos: [] })).toContain('이름이 없는');
  expect(planProblem({ items: [item(), item({ name: ' 로그인 화면 ' })], projectTodos: [] })).toContain('이름이 겹칩니다');
  expect(planProblem({ items: [item({ repoId: '' })], projectTodos: [] })).toContain('저장소가 비어');
  expect(planProblem({ items: [item({ baseBranch: '' })], projectTodos: [] })).toBeNull();
  expect(planProblem({ items: [item({ existing: true, repoId: '', baseBranch: '' })], projectTodos: [] })).toContain('만들 것이 없습니다');
  expect(planProblem({ items: [item({ existing: true, todos: [todo('x')] })], projectTodos: [] })).toBeNull();
  expect(planProblem({ items: [], projectTodos: [] })).toContain('만들 것이 없습니다');
});

test('tidyPlan: 빈 제목의 TODO 를 빼고 공백을 다듬는다', () => {
  expect(tidyPlan({ items: [item({ name: ' 화면 ', role: ' 폼 ', todos: [todo(' 폼 만들기 '), todo('')] })], projectTodos: [todo('  '), todo('결정')] })).toEqual({
    items: [item({ name: '화면', role: '폼', todos: [todo('폼 만들기')] })], projectTodos: [todo('결정')],
  });
});

test('specMessage: 글 파일은 내용을 블록에 넣고, 아니면 경로만 준다', () => {
  const m = specMessage({ path: '/docs/spec.md', name: 'spec.md', text: '# 로그인\n- 이메일', truncated: false });
  expect(m.startsWith('기획서 파일: /docs/spec.md\n\n```\n# 로그인\n- 이메일\n```\n\n')).toBe(true);
  expect(m).toContain('계획안을 올려줘');
  expect(specMessage({ path: '/docs/spec.pdf', name: 'spec.pdf', text: null, truncated: false })).toBe('기획서 파일: /docs/spec.pdf\n\n이 파일을 읽어줘. 이 기획서를 분석해서 계획안을 올려줘 (정리, 만들 워크스페이스, TODO). 내가 검토하고 승인한 뒤에 만들어져야 해.');
  expect(specMessage({ path: '/a.md', name: 'a.md', text: 'x', truncated: true })).toContain('앞부분만');
});

test('specMessage: 내용에 ``` 가 있어도 블록이 일찍 닫히지 않는다', () => {
  const m = specMessage({ path: '/a.md', name: 'a.md', text: '예시:\n```js\nx\n```\n끝', truncated: false });
  expect(m).toContain('\n````\n예시:\n```js\nx\n```\n끝\n````\n');
});
