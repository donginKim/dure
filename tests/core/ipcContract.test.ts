import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc';

test('IPC_CHANNELS 는 DureApi 의 모든 메서드를 한 번씩 담는다', () => {
  expect([...IPC_CHANNELS].sort()).toEqual([
    'projects.create', 'projects.list', 'projects.remove', 'projects.reopen',
    'coordinator.get', 'coordinator.approve', 'coordinator.reject',
    'cleanup.list', 'cleanup.restore', 'cleanup.export', 'cleanup.plan', 'cleanup.complete',
    'repos.add', 'repos.branches', 'repos.list', 'repos.pickFolder', 'repos.remove', 'repos.status',
    'terminals.buffer', 'terminals.kill', 'terminals.list', 'terminals.openShell', 'terminals.resize',
    'terminals.startAgent', 'terminals.write',
    'workspaces.create', 'workspaces.list', 'workspaces.remove', 'workspaces.uncommitted',
    'todos.add', 'todos.list', 'todos.move', 'todos.nudge', 'todos.pending', 'todos.remove', 'todos.update',
    'messages.threads', 'messages.list', 'messages.send', 'messages.pauseThread', 'messages.flow', 'messages.pauseProject',
    'messages.resume', 'messages.delivery', 'workspaces.interrupt', 'artifacts.list', 'artifacts.get',
    'commit.state', 'commit.run', 'commit.push',
    'settings.get', 'settings.update', 'settings.defaults', 'settings.models', 'settings.pickFolder',
    'chat.get', 'chat.step', 'chat.send', 'chat.answerPermission', 'chat.answerQuestion', 'chat.dismissQuestion', 'chat.commands',
    'workspaces.stopAgent', 'workspaces.setEngine',
  ].sort());
  expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
});

test('이벤트 채널 이름', () => {
  expect(IPC_EVENTS).toEqual({ terminalData: 'dure:terminal-data', terminalExit: 'dure:terminal-exit', changed: 'dure:changed' });
});
