import { openDatabase } from '@core/db';
import { handleHook, type HookDeps } from '@core/hooks';
import { ProjectStore, RepoStore, WorkspaceStore } from '@core/stores';
import { DeliveryService } from '@core/delivery';
import { MessageService } from '@core/messages';
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
  const messages = new MessageService(db);
  const delivery = new DeliveryService({ workspaces, todos, messages, actions: { isConfirmedIdle: () => false, wake: async () => undefined, start: async () => undefined } });
  const userPrompts: string[] = [];
  const deps: HookDeps = {
    workspaces, todos, onStatus: (id) => statusCalls.push(id),
    collect: (id) => delivery.collect(id), collectMessages: (id) => delivery.collectMessages(id),
    onUserPrompt: (w) => userPrompts.push(w.id),
  };
  const other = workspaces.insert({
    id: crypto.randomUUID(), projectId: p.id, repoId: r.id, name: '백엔드', nameLocked: true, branch: 'b2', baseBranch: 'main',
    worktreePath: '/tmp/w2', agentKind: 'claude', permissionMode: 'ask', token: 't2',
  });
  const receive = (body: string) => messages.send({ projectId: p.id, from: { kind: 'workspace', workspaceId: other.id }, toWorkspaceId: ws.id, body });
  const fire = (event: string, payload: unknown = {}) => handleHook(deps, workspaces.get(ws.id)!, event, payload);
  const status = () => workspaces.get(ws.id)!.status;
  const userAdds = (title: string) => todos.add({ projectId: p.id, workspaceId: ws.id, title }, 'user');
  return { fire, status, userAdds, todos, ws, p, statusCalls, receive, messages, userPrompts };
}

test('SessionStart: TODO 가 있으면 현재 목록을 additionalContext 로 다시 알려주고, 쌓인 변경 기록은 비운다', () => {
  const c = setup('working');
  c.todos.add({ projectId: c.p.id, workspaceId: c.ws.id, title: '링크 추가', status: 'doing' }, 'agent');
  c.userAdds('테스트 실행');
  const out = JSON.parse(c.fire('SessionStart', { source: 'compact' }));
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  const text: string = out.hookSpecificOutput.additionalContext;
  expect(text).toContain('[두레] 이 워크스페이스의 현재 TODO 다.');
  expect(text).toContain('진행 중:\n- 링크 추가');
  expect(text).toContain('할 일:\n- 테스트 실행');
  expect(text).toContain('사용자가 놓친 할 일이 보이면 todo_add 로 추가하라');
  // 목록 전체를 방금 알려줬으므로 변경 기록을 또 전달할 필요가 없다
  expect(c.todos.pendingCount(c.ws.id)).toBe(0);
  expect(c.status()).toBe('idle');
});

test('SessionStart: TODO 가 하나도 없으면 빈 글', () => {
  const c = setup('working');
  expect(c.fire('SessionStart', { source: 'startup' })).toBe('');
});

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

test('PostToolUse: 메시지도 additionalContext 에 실리고 전달됨으로 표시된다', () => {
  const c = setup('working');
  const m = c.receive('API 형식 정했다');
  const out = JSON.parse(c.fire('PostToolUse'));
  expect(out.hookSpecificOutput.additionalContext).toContain('워크스페이스 "백엔드" 이(가) 보낸 메시지다');
  expect(out.hookSpecificOutput.additionalContext).toContain('> API 형식 정했다');
  expect(c.messages.messages(m.threadId)[0].deliveredAt).not.toBeNull();
  expect(c.fire('PostToolUse')).toBe('');
});

test('Stop: 메시지가 있으면 block, 없으면 idle', () => {
  const c = setup('working');
  c.receive('답장');
  expect(JSON.parse(c.fire('Stop')).decision).toBe('block');
  expect(c.status()).toBe('working');
  expect(c.fire('Stop')).toBe('');
  expect(c.status()).toBe('idle');
});

test('SessionStart: 미전달 메시지도 함께 넣어준다', () => {
  const c = setup('working');
  c.receive('꺼져 있는 동안 온 말');
  const out = JSON.parse(c.fire('SessionStart', { source: 'resume' }));
  expect(out.hookSpecificOutput.additionalContext).toContain('> 꺼져 있는 동안 온 말');
});

test('UserPromptSubmit: 프롬프트가 [두레] 로 시작하지 않으면 사용자 개입으로 친다', () => {
  const c = setup('idle');
  c.fire('UserPromptSubmit', { prompt: '로그인 화면 고쳐줘' });
  expect(c.userPrompts).toEqual([c.ws.id]);
});

test('UserPromptSubmit: 프롬프트가 [두레] 로 시작하거나 본문이 없으면 사용자 개입이 아니다', () => {
  const c = setup('idle');
  c.fire('UserPromptSubmit', { prompt: '[두레] 워크스페이스 "백엔드" 이(가) 보낸 메시지다.' });
  c.fire('UserPromptSubmit', {});
  c.fire('UserPromptSubmit', 'not json');
  expect(c.userPrompts).toEqual([]);
});
