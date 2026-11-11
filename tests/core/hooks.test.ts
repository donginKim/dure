import { openDatabase } from '@core/db';
import { handleHook, type HookDeps } from '@core/hooks';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import { pendingMessage, TodoService } from '@core/todos';
import type { WorkspaceStatus } from '@shared/types';

// 실험 10 에서 받은 실제 본문 (spikes/out/notification.json)
const PERMISSION = { hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' };

function setup(initial: WorkspaceStatus = 'idle') {
  const db = openDatabase(':memory:');
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const workspaces = new WorkspaceStore(db);
  const todos = new TodoService(db);
  const p = projects.create('p');
  const r = repos.add(p.id, '/tmp/r');
  const ws = workspaces.insert({
    id: crypto.randomUUID(), projectId: p.id, repoId: r.id, name: 'w', nameLocked: true, branch: 'b', baseBranch: 'main',
    worktreePath: '/tmp/w', agentKind: 'claude', permissionMode: 'ask', token: 't',
  });
  workspaces.update(ws.id, { status: initial });
  const statusCalls: string[] = [];
  const deps: HookDeps = { workspaces, todos, onStatus: (id) => statusCalls.push(id) };
  const fire = (event: string, payload: unknown = {}) => handleHook(deps, workspaces.get(ws.id)!, event, payload);
  const status = () => workspaces.get(ws.id)!.status;
  const userAdds = (title: string) => todos.add({ projectId: p.id, workspaceId: ws.id, title }, 'user');
  return { fire, status, userAdds, todos, ws, statusCalls };
}

test.each([['SessionStart', 'idle'], ['UserPromptSubmit', 'working'], ['PreToolUse', 'working'], ['PostToolUse', 'working']] as const)(
  '%s 는 상태를 %s 로 바꾼다', (event, expected) => {
    const c = setup(event === 'SessionStart' ? 'working' : 'idle');
    expect(c.fire(event)).toBe('');
    expect(c.status()).toBe(expected);
  });

test('Stop: 미전달 변경이 없으면 idle 이고 빈 글', () => {
  const c = setup('working');
  expect(c.fire('Stop')).toBe('');
  expect(c.status()).toBe('idle');
});

test('Stop: 미전달 변경이 있으면 block 응답이고 상태는 working 그대로, 두 번째 Stop 은 빈 글에 idle', () => {
  const c = setup('working');
  c.userAdds('A');
  const out = JSON.parse(c.fire('Stop'));
  expect(out).toEqual({ decision: 'block', reason: pendingMessage(['추가됨: "A"']) });
  expect(c.status()).toBe('working');
  expect(c.fire('Stop')).toBe('');
  expect(c.status()).toBe('idle');
});

test('PostToolUse: 미전달 변경을 additionalContext 로 돌려주고 한 번만 돌려준다', () => {
  const c = setup('working');
  c.userAdds('A');
  const out = JSON.parse(c.fire('PostToolUse'));
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: pendingMessage(['추가됨: "A"']) } });
  expect(c.fire('PostToolUse')).toBe('');
});

test('UserPromptSubmit: 미전달 변경을 additionalContext 로 돌려준다', () => {
  const c = setup('idle');
  c.userAdds('A');
  const out = JSON.parse(c.fire('UserPromptSubmit'));
  expect(out.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: pendingMessage(['추가됨: "A"']) });
  expect(c.todos.pendingCount(c.ws.id)).toBe(0);
});

test('PreToolUse 는 미전달 변경을 가져가지 않는다', () => {
  const c = setup('working');
  c.userAdds('A');
  expect(c.fire('PreToolUse')).toBe('');
  expect(c.todos.pendingCount(c.ws.id)).toBe(1);
});

test('제목에 따옴표·줄바꿈·</script> 가 있어도 응답이 올바른 JSON 이다', () => {
  const c = setup('working');
  const title = '"따옴표" 와\n줄바꿈 </script>\\';
  c.userAdds(title);
  const out = JSON.parse(c.fire('Stop'));
  expect(out.reason).toContain(`추가됨: "${title}"`);
});

test('Notification: 승인 요청이면 waiting_user, 다른 알림이면 상태 그대로', () => {
  const c = setup('working');
  expect(c.fire('Notification', PERMISSION)).toBe('');
  expect(c.status()).toBe('waiting_user');
  const d = setup('working');
  d.fire('Notification', { hook_event_name: 'Notification', message: 'something else', notification_type: 'other' });
  expect(d.status()).toBe('working');
  d.fire('Notification', 'not json at all');
  expect(d.status()).toBe('working');
});

test('waiting_user 에서 PostToolUse 가 오면 working 으로 돌아온다', () => {
  const c = setup('waiting_user');
  c.fire('PostToolUse');
  expect(c.status()).toBe('working');
});

test('stopped 인 워크스페이스는 hook 이 와도 stopped 그대로', () => {
  const c = setup('stopped');
  c.fire('UserPromptSubmit');
  c.fire('Stop');
  expect(c.status()).toBe('stopped');
  expect(c.statusCalls).toEqual([]);
});

test('상태가 바뀔 때만 onStatus 가 불린다', () => {
  const c = setup('idle');
  c.fire('PreToolUse');
  c.fire('PostToolUse');
  c.fire('PreToolUse');
  expect(c.statusCalls).toEqual([c.ws.id]);
  c.fire('Stop');
  expect(c.statusCalls).toEqual([c.ws.id, c.ws.id]);
});

test('모르는 이벤트는 빈 글이고 아무것도 바꾸지 않는다', () => {
  const c = setup('working');
  c.userAdds('A');
  expect(c.fire('Whatever')).toBe('');
  expect(c.status()).toBe('working');
  expect(c.todos.pendingCount(c.ws.id)).toBe(1);
});
