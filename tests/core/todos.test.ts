import { openDatabase } from '@core/db';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import { pendingMessage, rollup, TodoConflictError, TodoService, TodoWaitingError } from '@core/todos';

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

describe('todoDigest (컨텍스트가 새로 시작될 때 다시 알려주는 글)', () => {
  test('항목이 없으면 undefined', async () => {
    const { todoDigest } = await import('@core/todos');
    expect(todoDigest([], [])).toBeUndefined();
  });

  test('남은 일을 상태와 담당별로 묶고, 끝난 일은 개수만 알린다', async () => {
    const { todoDigest } = await import('@core/todos');
    const { todos, p, front, addWs } = setup();
    addWs('코드 살펴보기', 'agent', { status: 'done' });
    addWs('링크 추가', 'agent', { status: 'doing' });
    addWs('테스트 실행');
    addWs('문구 다듬기', 'agent', { status: 'cancelled' });
    addWs('커밋', 'agent', { assignee: 'user' });
    addWs('이미 한 배포', 'agent', { assignee: 'user', status: 'done' });
    todos.add({ projectId: p.id, workspaceId: null, title: '로그인 기능 출시' }, 'user');
    todos.add({ projectId: p.id, workspaceId: null, title: '끝난 프로젝트 일', status: 'done' }, 'user');
    const all = todos.listProject(p.id);
    expect(todoDigest(all.filter((t) => t.workspaceId === front.id), all.filter((t) => t.workspaceId === null))).toBe([
      '[두레] 이 워크스페이스의 현재 TODO 다. 컨텍스트가 새로 시작되거나 압축돼서 다시 알려준다.',
      '진행 중:',
      '- 링크 추가',
      '할 일:',
      '- 테스트 실행',
      '사용자가 할 일:',
      '- 커밋',
      '프로젝트 전체의 할 일 (읽기 전용):',
      '- 로그인 기능 출시',
      '완료 3건, 취소 1건.', // 워크스페이스 2건 + 프로젝트 1건
      '빠졌거나 사용자가 놓친 할 일이 보이면 todo_add 로 추가하라. 사용자가 해야 하는 일이면 assignee 를 user 로 한다. 항목을 고치기 전에는 todo_list 로 rev 를 읽어라.',
    ].join('\n'));
  });

  test('남은 일이 없고 끝난 일만 있어도 알려준다', async () => {
    const { todoDigest } = await import('@core/todos');
    const { todos, front, addWs } = setup();
    addWs('A', 'agent', { status: 'done' });
    const text = todoDigest(todos.listWorkspace(front.id), [])!;
    expect(text).toContain('완료 1건, 취소 0건.');
    expect(text).not.toContain('할 일:');
  });
});

describe('프로젝트 항목과 거기에 딸린 워크스페이스 항목', () => {
  test('rollup: 다 끝나면 완료, 하나라도 시작되면 진행 중, 취소한 것은 빼고 본다', () => {
    const s = (...list: string[]) => rollup(list.map((status) => ({ status: status as never })));
    expect(s()).toBeNull();
    expect(s('cancelled')).toBeNull();
    expect(s('todo', 'todo')).toBe('todo');
    expect(s('todo', 'doing')).toBe('doing');
    expect(s('done', 'todo')).toBe('doing');
    expect(s('done', 'done', 'cancelled')).toBe('done');
  });

  test('딸린 항목의 진행에 따라 프로젝트 항목의 상태가 저절로 바뀐다', () => {
    const { todos, p, front, back } = setup();
    const big = todos.add({ projectId: p.id, title: '로그인 기능' }, 'agent');
    const a = todos.add({ projectId: p.id, workspaceId: front.id, title: '폼', parentId: big.id }, 'agent');
    const b = todos.add({ projectId: p.id, workspaceId: back.id, title: 'API', parentId: big.id }, 'agent');
    expect(a.parentId).toBe(big.id);
    expect(todos.children(big.id).map((t) => t.title)).toEqual(['폼', 'API']);
    expect(todos.get(big.id)!.status).toBe('todo');
    todos.update(a.id, { status: 'doing' }, { actor: 'agent', rev: 1 });
    expect(todos.get(big.id)).toMatchObject({ status: 'doing', rev: 2 });
    todos.update(a.id, { status: 'done' }, { actor: 'agent', rev: 2 });
    expect(todos.get(big.id)!.status).toBe('doing');
    todos.update(b.id, { status: 'done' }, { actor: 'user' });
    expect(todos.get(big.id)!.status).toBe('done');
    // 새 일이 딸리면 다시 열린다
    const c = todos.add({ projectId: p.id, workspaceId: back.id, title: '시험', parentId: big.id }, 'agent');
    expect(todos.get(big.id)!.status).toBe('doing');
    // 지우거나 취소하면 남은 것으로 다시 본다
    todos.update(c.id, { status: 'cancelled' }, { actor: 'user' });
    expect(todos.get(big.id)!.status).toBe('done');
    todos.update(c.id, { status: 'todo' }, { actor: 'user' });
    todos.remove(c.id, { actor: 'user' });
    expect(todos.get(big.id)!.status).toBe('done');
  });

  test('달고 떼기: 같은 프로젝트의 프로젝트 항목에만 달 수 있고, 프로젝트 항목을 지우면 딸린 항목은 남는다', () => {
    const { todos, projects, p, front } = setup();
    const big = todos.add({ projectId: p.id, title: '큰 일' }, 'agent');
    const other = todos.add({ projectId: p.id, title: '다른 큰 일' }, 'agent');
    const a = todos.add({ projectId: p.id, workspaceId: front.id, title: '작은 일', status: 'done' }, 'agent');
    expect(todos.setParent(a.id, big.id).parentId).toBe(big.id);
    expect(todos.get(big.id)!.status).toBe('done');
    // 옮기면 앞의 것은 그대로 두고 (딸린 것이 없다), 새 것이 맞춰진다
    todos.setParent(a.id, other.id);
    expect([todos.get(big.id)!.status, todos.get(other.id)!.status]).toEqual(['done', 'done']);
    expect(todos.setParent(a.id, null).parentId).toBeNull();
    // 워크스페이스 항목 아래, 다른 프로젝트의 항목 아래, 프로젝트 항목끼리는 안 된다
    const b = todos.add({ projectId: p.id, workspaceId: front.id, title: '또 작은 일' }, 'agent');
    expect(() => todos.setParent(a.id, b.id)).toThrow('그런 프로젝트 항목이 없습니다');
    const p2 = projects.create('다른 프로젝트');
    const far = todos.add({ projectId: p2.id, title: '남의 큰 일' }, 'agent');
    expect(() => todos.setParent(a.id, far.id)).toThrow('그런 프로젝트 항목이 없습니다');
    expect(() => todos.setParent(other.id, big.id)).toThrow('다른 항목 아래에 둘 수 없습니다');
    expect(() => todos.add({ projectId: p.id, title: 'x', parentId: big.id }, 'agent')).toThrow('다른 항목 아래에 둘 수 없습니다');
    // 프로젝트 항목을 지운다
    todos.setParent(a.id, big.id);
    todos.remove(big.id, { actor: 'user' });
    expect(todos.get(a.id)).toMatchObject({ title: '작은 일', parentId: null });
    // 취소해 둔 프로젝트 항목은 딸린 것이 바뀌어도 그대로다
    todos.update(other.id, { status: 'cancelled' }, { actor: 'user' });
    todos.setParent(b.id, other.id);
    todos.update(b.id, { status: 'done' }, { actor: 'user' });
    expect(todos.get(other.id)!.status).toBe('cancelled');
  });
});

describe('일의 순서 (앞의 일)', () => {
  test('앞의 일이 끝나기 전에는 에이전트가 시작하거나 완료할 수 없다. 사용자는 넘어설 수 있다', () => {
    const { todos, p, front, back } = setup();
    const api = todos.add({ projectId: p.id, workspaceId: back.id, title: 'API' }, 'agent');
    const ui = todos.add({ projectId: p.id, workspaceId: front.id, title: '화면', after: [api.id] }, 'agent');
    expect(ui.after).toEqual([api.id]);
    expect(todos.blockers(ui).map((t) => t.title)).toEqual(['API']);
    expect(() => todos.update(ui.id, { status: 'doing' }, { actor: 'agent', rev: ui.rev })).toThrow(TodoWaitingError);
    expect(() => todos.update(ui.id, { status: 'done' }, { actor: 'agent', rev: ui.rev })).toThrow('앞의 일이 끝나지 않았습니다');
    // 제목 바꾸기, 취소는 된다
    expect(todos.update(ui.id, { title: '로그인 화면' }, { actor: 'agent', rev: ui.rev }).title).toBe('로그인 화면');
    // 사용자는 순서를 넘어설 수 있다
    const u2 = todos.add({ projectId: p.id, workspaceId: front.id, title: '다른 화면', after: [api.id] }, 'agent');
    expect(todos.update(u2.id, { status: 'doing' }, { actor: 'user' }).status).toBe('doing');
  });

  test('앞의 일이 다 끝나면 알린다. 취소되거나 지워져도 풀린다. 하나라도 남으면 알리지 않는다', () => {
    const { todos, p, front, back } = setup();
    const seen: string[] = [];
    todos.on('unblocked', (t: { title: string }, done: { title: string }) => seen.push(`${t.title}<-${done.title}`));
    const a = todos.add({ projectId: p.id, workspaceId: back.id, title: 'A' }, 'agent');
    const b = todos.add({ projectId: p.id, workspaceId: back.id, title: 'B' }, 'agent');
    const ui = todos.add({ projectId: p.id, workspaceId: front.id, title: '화면', after: [a.id, b.id] }, 'agent');
    todos.update(a.id, { status: 'done' }, { actor: 'agent', rev: a.rev });
    expect(seen).toEqual([]);
    todos.update(b.id, { status: 'cancelled' }, { actor: 'user' });
    expect(seen).toEqual(['화면<-B']);
    expect(todos.blockers(todos.get(ui.id)!)).toEqual([]);
    expect(todos.update(ui.id, { status: 'doing' }, { actor: 'agent', rev: todos.get(ui.id)!.rev }).status).toBe('doing');
    // 지워진 앞의 일
    const c = todos.add({ projectId: p.id, workspaceId: back.id, title: 'C' }, 'agent');
    const d = todos.add({ projectId: p.id, workspaceId: front.id, title: 'D', after: [c.id] }, 'agent');
    todos.remove(c.id, { actor: 'user' });
    expect(seen).toEqual(['화면<-B', 'D<-C']);
    expect(todos.get(d.id)!.after).toEqual([]);
    // 다시 열렸다가 다시 끝나도 이미 끝난 뒤의 일에는 알리지 않는다
    todos.update(a.id, { status: 'todo' }, { actor: 'user' });
    todos.update(ui.id, { status: 'done' }, { actor: 'user' });
    todos.update(a.id, { status: 'done' }, { actor: 'user' });
    expect(seen.length).toBe(2);
  });

  test('앞의 일 정하기: 같은 프로젝트의 워크스페이스 항목만, 돌고 도는 순서는 받지 않는다', () => {
    const { todos, projects, p, front, back } = setup();
    const a = todos.add({ projectId: p.id, workspaceId: back.id, title: 'A' }, 'agent');
    const b = todos.add({ projectId: p.id, workspaceId: front.id, title: 'B', after: [a.id] }, 'agent');
    const c = todos.add({ projectId: p.id, workspaceId: front.id, title: 'C' }, 'agent');
    expect(todos.setAfter(c.id, [b.id, b.id]).after).toEqual([b.id]);
    expect(() => todos.setAfter(a.id, [c.id])).toThrow('돌고 돕니다');
    expect(() => todos.setAfter(a.id, [a.id])).toThrow('자기 자신');
    const big = todos.add({ projectId: p.id, title: '큰 일' }, 'agent');
    expect(() => todos.setAfter(a.id, [big.id])).toThrow('둘 수 없는 항목');
    expect(() => todos.setAfter(big.id, [a.id])).toThrow('프로젝트 항목에는');
    const far = todos.add({ projectId: projects.create('다른').id, title: 'x' }, 'agent');
    expect(() => todos.setAfter(a.id, [far.id])).toThrow('둘 수 없는 항목');
    expect(todos.setAfter(c.id, []).after).toEqual([]);
    // 사용자가 정하면 에이전트에게 전해진다
    expect(todos.takePending(front.id).some((l) => l.includes('순서 풀림'))).toBe(true);
  });
});
