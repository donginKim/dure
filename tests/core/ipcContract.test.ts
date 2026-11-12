import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc';

test('IPC_CHANNELS 는 DureApi 의 모든 메서드를 한 번씩 담는다', () => {
  expect([...IPC_CHANNELS].sort()).toEqual([
    'projects.create', 'projects.list', 'projects.remove', 'projects.reopen',
    'coordinator.get', 'coordinator.approve', 'coordinator.reject', 'coordinator.pickSpec',
    'pr.info', 'pr.create', 'pr.open', 'checkpoints.list', 'checkpoints.create', 'checkpoints.preview', 'checkpoints.restore', 'usage.summary', 'attention.list', 'notes.list', 'notes.get', 'notes.create', 'notes.update', 'notes.remove', 'update.status', 'update.check', 'update.apply', 'update.dismiss', 'slack.status', 'slack.connect', 'slack.disconnect', 'slack.setAccess', 'slack.requests', 'slack.decide', 'db.list', 'db.canStoreSecrets', 'db.save', 'db.remove', 'db.test', 'db.tables', 'db.columns', 'db.query', 'db.requests', 'db.decide',
    'cleanup.list', 'cleanup.restore', 'cleanup.export', 'cleanup.plan', 'cleanup.complete',
    'repos.add', 'repos.branches', 'repos.list', 'repos.pickFolder', 'repos.remove', 'repos.status',
    'terminals.buffer', 'terminals.kill', 'terminals.list', 'terminals.openShell', 'terminals.resize',
    'terminals.startAgent', 'terminals.write',
    'workspaces.create', 'workspaces.list', 'workspaces.remove', 'workspaces.uncommitted',
    'todos.add', 'todos.list', 'todos.move', 'todos.nudge', 'todos.pending', 'todos.remove', 'todos.update',
    'messages.threads', 'messages.list', 'messages.send', 'messages.pauseThread', 'messages.flow', 'messages.pauseProject',
    'messages.resume', 'messages.delivery', 'workspaces.interrupt', 'artifacts.list', 'artifacts.get',
    'browser.register', 'assignments.outgoing', 'assignments.incoming', 'assignments.accept', 'assignments.decline', 'assignments.briefs', 'assignments.takeBrief', 'assignments.dropBrief',
    'peers.status', 'peers.found', 'peers.list', 'peers.requests', 'peers.connect', 'peers.accept', 'peers.dismiss', 'peers.setMode', 'peers.remove',
    'peers.share', 'peers.createShare', 'peers.invite', 'peers.invites', 'peers.acceptInvite', 'peers.declineInvite', 'peers.leave', 'peers.removeMember',
    'peers.sharing', 'peers.setSharing', 'peers.remote', 'peers.names', 'peers.held', 'peers.pass', 'peers.answer', 'peers.drop', 'browser.requests', 'browser.decide', 'commit.state', 'commit.diff', 'commit.run', 'commit.push',
    'settings.get', 'settings.update', 'settings.defaults', 'settings.models', 'settings.pickFolder',
    'chat.get', 'chat.step', 'chat.send', 'chat.answerPermission', 'chat.answerQuestion', 'chat.dismissQuestion', 'chat.commands',
    'workspaces.stopAgent', 'workspaces.setEngine', 'workspaces.rename', 'workspaces.setAutoName',
  ].sort());
  expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
});

test('이벤트 채널 이름', () => {
  expect(IPC_EVENTS).toEqual({ terminalData: 'dure:terminal-data', terminalExit: 'dure:terminal-exit', changed: 'dure:changed', browserOpen: 'dure:browser-open', attentionOpen: 'dure:attention-open' });
});
