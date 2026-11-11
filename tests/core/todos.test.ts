import { openDatabase } from '@core/db';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import { pendingMessage, TodoConflictError, TodoService } from '@core/todos';

function setup() {
  const db = openDatabase(':memory:');
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const workspaces = new WorkspaceStore(db);
  const p = projects.create('쇼핑몰');
  const r = repos.add(p.id, '/tmp/shop');
  const mk = (name: string) => workspaces.insert({
    id: crypto.randomUUID(), projectId: p.id, repoId: r.id, name, nameLocked: true, branch: `dure/${name}`, baseBranch: 'main',
    worktreePath: `/tmp/wt/${name}`, agentKind: 'claude', permissionMode: 'ask', token: `tok-${name}`,
  });
  const front = mk('front');
  const back = mk('back');
  const todos = new TodoService(db);
  const addWs = (title: string, actor: 'user' | 'agent' = 'agent', over = {}) =>
    todos.add({ projectId: p.id, workspaceId: front.id, title, ...over }, actor);
  return { db, projects, workspaces, todos, p, front, back, addWs };
}

test('add 는 범위의 맨 끝에 넣고 rev 는 1', () => {
  const { addWs } = setup();
  const a = addWs('A');
  const b = addWs('B');
  expect(a).toMatchObject({ title: 'A', detail: '', status: 'todo', assignee: 'agent', rev: 1, updatedBy: 'agent', position: 1 });
  expect(b.position).toBe(2);
});

test('listWorkspace 는 그 워크스페이스 항목만, listProject 는 프로젝트 범위와 모든 워크스페이스 항목', () => {
  const { todos, p, front, back, addWs } = setup();
  addWs('F1');
  todos.add({ projectId: p.id, workspaceId: back.id, title: 'B1' }, 'agent');
  todos.add({ projectId: p.id, workspaceId: null, title: 'P1' }, 'user');
  expect(todos.listWorkspace(front.id).map((t) => t.title)).toEqual(['F1']);
  expect(todos.listProject(p.id).map((t) => t.title).sort()).toEqual(['B1', 'F1', 'P1']);
});

test('사용자 update 는 rev 를 올리고 updatedBy 가 user', () => {
  const { todos, addWs } = setup();
  const a = addWs('A');
  const u = todos.update(a.id, { title: 'A2' }, { actor: 'user' });
  expect(u).toMatchObject({ title: 'A2', rev: 2, updatedBy: 'user' });
});

test('값이 같으면 rev 가 오르지 않고 미전달 변경도 없다', () => {
  const { todos, front, addWs } = setup();
  const a = addWs('A');
  const u = todos.update(a.id, { title: 'A', status: 'todo' }, { actor: 'user' });
  expect(u.rev).toBe(1);
  expect(todos.pendingCount(front.id)).toBe(0);
});

test('제목은 앞뒤 공백을 떼고, 비면 오류', () => {
  const { todos, addWs } = setup();
  expect(addWs('  A  ').title).toBe('A');
  expect(() => addWs('   ')).toThrow();
  const a = addWs('B');
  expect(() => todos.update(a.id, { title: ' ' }, { actor: 'user' })).toThrow();
});

test('에이전트가 옛 rev 로 고치면 TodoConflictError 이고 사용자 값이 남는다', () => {
  const { todos, addWs } = setup();
  const a = addWs('로그인 API');
  todos.update(a.id, { title: '로그인 API v2' }, { actor: 'user' });
  let err: unknown;
  try { todos.update(a.id, { status: 'done' }, { actor: 'agent', rev: 1 }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(TodoConflictError);
  expect((err as TodoConflictError).current.title).toBe('로그인 API v2');
  expect(todos.get(a.id)).toMatchObject({ title: '로그인 API v2', status: 'todo', rev: 2 });
});

test('에이전트가 맞는 rev 로 고치면 통과하고 미전달 변경은 쌓이지 않는다', () => {
  const { todos, front, addWs } = setup();
  const a = addWs('A');
  const u = todos.update(a.id, { status: 'doing' }, { actor: 'agent', rev: 1 });
  expect(u).toMatchObject({ status: 'doing', rev: 2, updatedBy: 'agent' });
  expect(todos.pendingCount(front.id)).toBe(0);
});

test('에이전트의 remove 도 rev 가 다르면 거절된다', () => {
  const { todos, addWs } = setup();
  const a = addWs('A');
  todos.update(a.id, { detail: 'd' }, { actor: 'user' });
  expect(() => todos.remove(a.id, { actor: 'agent', rev: 1 })).toThrow(TodoConflictError);
  expect(todos.get(a.id)).toBeDefined();
  todos.remove(a.id, { actor: 'agent', rev: 2 });
  expect(todos.get(a.id)).toBeUndefined();
});

describe('사용자 변경의 미전달 문구', () => {
  const cases: [string, (c: ReturnType<typeof setup>) => void, string[]][] = [
    ['add', (c) => { c.addWs('배포', 'user', { assignee: 'user' }); }, ['추가됨: "배포" (사용자 몫)']],
    ['add(agent 담당)', (c) => { c.addWs('A', 'user'); }, ['추가됨: "A"']],
    ['title', (c) => { const a = c.addWs('A'); c.todos.update(a.id, { title: 'B' }, { actor: 'user' }); }, ['제목 바뀜: "A" → "B"']],
    ['detail', (c) => { const a = c.addWs('A'); c.todos.update(a.id, { detail: 'x' }, { actor: 'user' }); }, ['설명 바뀜: "A"']],
    ['done', (c) => { const a = c.addWs('A'); c.todos.update(a.id, { status: 'done' }, { actor: 'user' }); }, ['사용자가 직접 완료함: "A"']],
    ['cancelled', (c) => { const a = c.addWs('A'); c.todos.update(a.id, { status: 'cancelled' }, { actor: 'user' }); }, ['취소됨: "A"']],
    ['reopen', (c) => { const a = c.addWs('A', 'agent', { status: 'done' }); c.todos.update(a.id, { status: 'todo' }, { actor: 'user' }); }, ['다시 열림: "A"']],
    ['assignee', (c) => { const a = c.addWs('A'); c.todos.update(a.id, { assignee: 'user' }, { actor: 'user' }); }, ['담당 바뀜: "A" → 사용자']],
    ['assignee back', (c) => { const a = c.addWs('A', 'agent', { assignee: 'user' }); c.todos.update(a.id, { assignee: 'agent' }, { actor: 'user' }); }, ['담당 바뀜: "A" → 에이전트']],
    ['remove', (c) => { const a = c.addWs('A'); c.todos.remove(a.id, { actor: 'user' }); }, ['삭제됨: "A"']],
    ['move', (c) => { c.addWs('A'); const b = c.addWs('B'); c.todos.move(b.id, 'up'); }, ['순서 바뀜: "B" 이(가) 1번째로']],
    ['여러 필드', (c) => { const a = c.addWs('A'); c.todos.update(a.id, { assignee: 'user', status: 'done', title: 'B' }, { actor: 'user' }); },
      ['제목 바뀜: "A" → "B"', '사용자가 직접 완료함: "B"', '담당 바뀜: "B" → 사용자']],
  ];
  test.each(cases)('%s', (_name, act, expected) => {
    const c = setup();
    act(c);
    expect(c.todos.pendingCount(c.front.id)).toBe(expected.length);
    expect(c.todos.takePending(c.front.id)).toEqual(expected);
  });
});

test('프로젝트 범위 항목의 사용자 변경은 미전달 변경을 만들지 않는다', () => {
  const { todos, p, front, back } = setup();
  const t = todos.add({ projectId: p.id, workspaceId: null, title: 'P' }, 'user');
  todos.update(t.id, { status: 'done' }, { actor: 'user' });
  expect(todos.pendingCount(front.id) + todos.pendingCount(back.id)).toBe(0);
});

test('미전달 변경은 그 항목의 워크스페이스에만 쌓인다', () => {
  const { todos, front, back, addWs } = setup();
  addWs('A', 'user');
  expect(todos.pendingCount(front.id)).toBe(1);
  expect(todos.pendingCount(back.id)).toBe(0);
});

test('takePending 은 한 번만 돌려준다', () => {
  const { todos, front, addWs } = setup();
  addWs('A', 'user');
  expect(todos.takePending(front.id)).toHaveLength(1);
  expect(todos.takePending(front.id)).toEqual([]);
  expect(todos.pendingCount(front.id)).toBe(0);
});

test('제목의 따옴표·줄바꿈·</script> 가 그대로 보존된다', () => {
  const { todos, front, addWs } = setup();
  const title = '"따옴표" 와\n줄바꿈 </script><b>x</b>';
  const a = addWs(title, 'user');
  expect(todos.get(a.id)?.title).toBe(title);
  expect(todos.takePending(front.id)).toEqual([`추가됨: "${title}"`]);
});

test('move 는 이웃과 자리를 바꾸고 끝에서는 그대로', () => {
  const { todos, front, addWs } = setup();
  const a = addWs('A'); const b = addWs('B'); const c = addWs('C');
  todos.move(c.id, 'up');
  expect(todos.listWorkspace(front.id).map((t) => t.title)).toEqual(['A', 'C', 'B']);
  todos.move(a.id, 'up');
  todos.move(b.id, 'down');
  expect(todos.listWorkspace(front.id).map((t) => t.title)).toEqual(['A', 'C', 'B']);
  todos.move(a.id, 'down');
  expect(todos.listWorkspace(front.id).map((t) => t.title)).toEqual(['C', 'A', 'B']);
});

test('removeWorkspace 뒤 그 항목과 미전달 변경이 없다', () => {
  const { todos, p, front, back, addWs } = setup();
  addWs('A', 'user');
  todos.add({ projectId: p.id, workspaceId: back.id, title: 'B' }, 'agent');
  todos.removeWorkspace(front.id);
  expect(todos.listWorkspace(front.id)).toEqual([]);
  expect(todos.pendingCount(front.id)).toBe(0);
  expect(todos.listWorkspace(back.id)).toHaveLength(1);
});

test('프로젝트를 지우면 그 TODO 도 지워진다', () => {
  const { todos, projects, p, addWs } = setup();
  addWs('A');
  todos.add({ projectId: p.id, workspaceId: null, title: 'P' }, 'user');
  projects.remove(p.id);
  expect(todos.listProject(p.id)).toEqual([]);
});

test('changed 이벤트가 프로젝트 id 와 함께 난다', () => {
  const { todos, p, addWs } = setup();
  const seen: string[] = [];
  todos.on('changed', (id) => seen.push(id));
  const a = addWs('A');
  todos.update(a.id, { status: 'done' }, { actor: 'agent', rev: 1 });
  expect(seen).toEqual([p.id, p.id]);
});

test('pendingMessage 형식', () => {
  expect(pendingMessage(['추가됨: "A"', '삭제됨: "B"'])).toBe(
    '[두레] 사용자가 TODO를 바꿨다. 다음 단계부터 반영하라:\n- 추가됨: "A"\n- 삭제됨: "B"\n현재 목록은 todo_list 도구로 확인하라.');
});

test('takePending 이 실제로 가져간 것이 있으면 delivered 이벤트가 난다', () => {
  const { todos, front, addWs } = setup();
  const seen: string[] = [];
  todos.on('delivered', (workspaceId) => seen.push(workspaceId));
  todos.takePending(front.id);
  expect(seen).toEqual([]);
  addWs('A', 'user');
  todos.takePending(front.id);
  expect(seen).toEqual([front.id]);
});

test('제목과 설명의 제어 문자는 저장하지 않는다 (줄바꿈은 남긴다)', () => {
  const { todos, front, addWs } = setup();
  const a = addWs('앞\x1b[201~\r!rm -rf x\x07\x7f뒤\n둘째 줄', 'user', { detail: 'd\x1b[0m' });
  expect(a.title).toBe('앞[201~!rm -rf x뒤\n둘째 줄');
  expect(a.detail).toBe('d[0m');
  const u = todos.update(a.id, { title: 'x\x1by' }, { actor: 'agent', rev: 1 });
  expect(u.title).toBe('xy');
  expect(todos.takePending(front.id).join('')).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
});

test('restorePending 은 가져갔던 줄을 다시 넣는다', () => {
  const { todos, front, addWs } = setup();
  addWs('A', 'user');
  const lines = todos.takePending(front.id);
  todos.restorePending(front.id, lines);
  expect(todos.takePending(front.id)).toEqual(['추가됨: "A"']);
});
