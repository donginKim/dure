import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc';

test('IPC_CHANNELS 는 DureApi 의 모든 메서드를 한 번씩 담는다', () => {
  expect([...IPC_CHANNELS].sort()).toEqual([
    'projects.create', 'projects.list', 'projects.remove',
    'repos.add', 'repos.branches', 'repos.list', 'repos.pickFolder', 'repos.remove', 'repos.status',
    'terminals.buffer', 'terminals.kill', 'terminals.list', 'terminals.openShell', 'terminals.resize',
    'terminals.startAgent', 'terminals.write',
    'workspaces.create', 'workspaces.list', 'workspaces.remove', 'workspaces.uncommitted',
    'todos.add', 'todos.list', 'todos.move', 'todos.nudge', 'todos.pending', 'todos.remove', 'todos.update',
    'messages.threads', 'messages.list', 'messages.send', 'messages.pauseThread', 'messages.flow', 'messages.pauseProject',
    'messages.resume', 'messages.delivery', 'workspaces.interrupt', 'artifacts.list', 'artifacts.get',
  ].sort());
  expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
});

test('이벤트 채널 이름', () => {
  expect(IPC_EVENTS).toEqual({ terminalData: 'dure:terminal-data', terminalExit: 'dure:terminal-exit', changed: 'dure:changed' });
});
