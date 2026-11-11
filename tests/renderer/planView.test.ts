import type { PlanDecision, ProposalItem } from '@shared/types';
import { approveLabel, draftRepoId, fromDraft, planCounts, planProblem, specMessage, tidyPlan, toDraft } from '../../src/renderer/planView';

const item = (o: Partial<ProposalItem> = {}): ProposalItem => ({ name: '로그인 화면', repoId: 'r1', baseBranch: 'main', role: '', todos: [], existing: false, ...o });
const todo = (title: string, assignee: 'agent' | 'user' = 'agent') => ({ title, detail: '', assignee });

test('planCounts 와 approveLabel: 새로 만들 워크스페이스와 제목이 있는 TODO 만 센다', () => {
  const d: PlanDecision = { items: [item({ todos: [todo('폼'), todo(' ')] }), item({ name: '이미 있던 것', existing: true, todos: [todo('고치기')] })], projectTodos: [todo('결정', 'user')] };
  expect(planCounts(d)).toEqual({ repos: 0, workspaces: 1, todos: 3 });
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
    newRepos: [], items: [item({ name: '화면', role: '폼', todos: [todo('폼 만들기')] })], projectTodos: [todo('결정')],
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

test('새 저장소: 수에 들어가고, 이름을 확인하고, 없는 새 저장소를 가리키는 워크스페이스를 잡는다', () => {
  const d: PlanDecision = { newRepos: [{ name: 'web', description: ' 웹 ' }], items: [item({ repoId: 'new:web' })], projectTodos: [] };
  expect(planCounts(d)).toEqual({ repos: 1, workspaces: 1, todos: 0 });
  expect(approveLabel(d)).toBe('승인하고 저장소 1개, 워크스페이스 1개 만들기');
  expect(planProblem(d)).toBeNull();
  expect(tidyPlan(d).newRepos).toEqual([{ name: 'web', description: '웹' }]);
  expect(planProblem({ ...d, newRepos: [{ name: '웹 사이트', description: '' }] })).toContain('영문, 숫자');
  expect(planProblem({ ...d, newRepos: [{ name: 'web', description: '' }, { name: 'Web', description: '' }] })).toContain('겹칩니다');
  expect(planProblem({ ...d, newRepos: [] })).toContain('새 저장소 목록에 없습니다');
  expect(planProblem({ newRepos: [{ name: 'web', description: '' }], items: [], projectTodos: [] })).toBeNull();
});

test('고치는 중인 계획: 새 저장소 이름을 치는 도중 다른 저장소와 같아져도 워크스페이스가 옮겨 가지 않는다', () => {
  let d = toDraft({ newRepos: [{ name: 'a', description: '' }], items: [item({ name: 'w', repoId: 'new:a' })], projectTodos: [] });
  expect(d.items[0]!.repoId).toBe(draftRepoId('r0'));
  // 새 저장소를 더하고 이름을 a, ab 순서로 친다
  d = { ...d, newRepos: [...d.newRepos, { name: '', description: '', key: 'n0' }] };
  for (const name of ['a', 'ab']) {
    d = { ...d, newRepos: d.newRepos.map((r) => (r.key === 'n0' ? { ...r, name } : r)) };
    expect(fromDraft(d).items[0]!.repoId).toBe('new:a');
  }
  expect(planProblem(fromDraft(d))).toBeNull();
  // 원래 저장소의 이름을 고치면 따라온다
  d = { ...d, newRepos: d.newRepos.map((r) => (r.key === 'r0' ? { ...r, name: 'api' } : r)) };
  expect(fromDraft(d).items[0]!.repoId).toBe('new:api');
  // 그 저장소를 빼면 문제로 잡힌다
  d = { ...d, newRepos: d.newRepos.filter((r) => r.key !== 'r0') };
  expect(fromDraft(d).items[0]!.repoId).toBe('new:');
  expect(planProblem(fromDraft(d))).toContain('새 저장소 목록에 없습니다');
});

test('새 저장소 이름: 화면도 코어와 같은 규칙으로 본다', () => {
  for (const name of ['x.', '.git', '-x', 'a b', '']) expect(planProblem({ newRepos: [{ name, description: '' }], items: [], projectTodos: [] })).toContain('영문, 숫자');
  expect(planProblem({ newRepos: [{ name: ' web ', description: '' }], items: [], projectTodos: [] })).toBeNull();
});
