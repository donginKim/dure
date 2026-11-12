import type { PlanDecision, ProposalItem } from '@shared/types';
import { approveLabel, assignChoiceProblem, assignProgressLine, draftRepoId, fromDraft, planCounts, planProblem, specMessage, tidyPlan, toDraft } from '../../src/renderer/planView';

const item = (o: Partial<ProposalItem> = {}): ProposalItem => ({ name: '로그인 화면', repoId: 'r1', baseBranch: 'main', role: '', todos: [], existing: false, ...o });
const todo = (title: string, assignee: 'agent' | 'user' = 'agent') => ({ title, detail: '', assignee });

test('planCounts 와 approveLabel: 새로 만들 워크스페이스와 제목이 있는 TODO 만 센다', () => {
  const d: PlanDecision = { items: [item({ todos: [todo('폼'), todo(' ')] }), item({ name: '이미 있던 것', existing: true, todos: [todo('고치기')] })], projectTodos: [todo('결정', 'user')] };
  expect(planCounts(d)).toEqual({ repos: 0, workspaces: 1, todos: 3, handed: 0, added: 0 });
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
    newRepos: [], addRepos: [], items: [item({ name: '화면', role: '폼', todos: [todo('폼 만들기')] })], projectTodos: [todo('결정')],
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
  expect(planCounts(d)).toEqual({ repos: 1, workspaces: 1, todos: 0, handed: 0, added: 0 });
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

describe('일 나눠 주기', () => {
  const item2 = (o: Partial<ProposalItem> = {}): ProposalItem => ({ name: '화면', repoId: 'r1', baseBranch: 'main', role: '', todos: [{ title: '폼', detail: '', assignee: 'agent' }], existing: false, ...o });

  test('나눠 주는 워크스페이스는 내 PC 에 만들 것으로 세지 않는다. 저장소가 비어 있어도 된다', () => {
    const d = { newRepos: [], items: [item2(), item2({ name: '서버', repoId: '', baseBranch: '', owner: 'p1' })], projectTodos: [] };
    expect(planCounts(d)).toEqual({ repos: 0, workspaces: 1, todos: 1, handed: 1, added: 0 });
    expect(planProblem(d)).toBeNull();
    expect(approveLabel(d)).toBe('승인하고 워크스페이스 1개, TODO 1개 만들기, 1개 나눠 주기');
    const only = { newRepos: [], items: [item2({ repoId: '', owner: 'p1' })], projectTodos: [] };
    expect(planProblem(only)).toBeNull();
    expect(approveLabel(only)).toBe('승인하고 워크스페이스 1개 나눠 주기');
  });

  test('나눠 준 일의 진행을 한 줄로', () => {
    const base = { id: 'a', projectId: 'p', peerId: 'x', peerName: '개발', items: [], progress: [], note: '', createdAt: 0, updatedAt: 0 };
    expect(assignProgressLine({ ...base, state: 'sent' })).toBe('그 사람이 수락해야 만들어집니다');
    expect(assignProgressLine({ ...base, state: 'declined', note: '바쁨' })).toBe('거절: 바쁨');
    expect(assignProgressLine({ ...base, state: 'accepted' })).toBe('진행 상황을 공개하지 않았습니다');
    const todos = [{ title: 'a', status: 'done', assignee: 'agent' }, { title: 'b', status: 'doing', assignee: 'agent' }, { title: 'c', status: 'cancelled', assignee: 'agent' }];
    expect(assignProgressLine({ ...base, state: 'accepted', progress: [{ workspaceId: 'w', name: '서버', status: 'working', summary: '', todos }] })).toBe('TODO 1/2 끝남');
  });

  test('받은 배정은 워크스페이스마다 저장소를 골라야 수락할 수 있다', () => {
    const items = [{ name: '서버', role: '', todos: [] }, { name: '알림', role: '', todos: [] }];
    expect(assignChoiceProblem(items, [{ repoId: 'r1' }, { repoId: '' }])).toContain('"알림"');
    expect(assignChoiceProblem(items, [{ repoId: 'r1' }, { repoId: '', newRepo: '한글' }])).toContain('영문');
    expect(assignChoiceProblem(items, [{ repoId: 'r1' }, { repoId: '', newRepo: 'api' }])).toBeNull();
    expect(assignChoiceProblem(items, [{ repoId: 'r1', name: '알림' }, { repoId: 'r1' }])).toContain('겹칩니다');
  });
});

test('이미 있는 폴더를 등록하는 계획: 등록만 있어도 승인할 수 있고, 뺀 폴더를 가리키는 워크스페이스를 잡는다', () => {
  const f = { path: '/p/catalog-web', name: 'catalog-web', remote: '' };
  const ws = { name: '화면', repoId: 'path:/p/catalog-web', baseBranch: '', role: '', todos: [], existing: false };
  expect(approveLabel({ addRepos: [f], items: [], projectTodos: [] })).toBe('승인하고 저장소 1개 등록');
  expect(planProblem({ addRepos: [f], items: [], projectTodos: [] })).toBeNull();
  expect(approveLabel({ addRepos: [f], items: [ws], projectTodos: [] })).toBe('승인하고 저장소 1개 등록, 워크스페이스 1개 만들기');
  expect(planProblem({ addRepos: [], items: [ws], projectTodos: [] })).toContain('등록할 저장소 목록에 없습니다');
});
