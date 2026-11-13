import { contextBridge, ipcRenderer } from 'electron';
import { IPC_EVENTS, ipcName, type ChangeTopic, type DureApi, type IpcChannel } from '@shared/ipc';
import type { AttentionItem } from '@shared/types';

// Electron 이 오류 메시지 앞에 붙이는 문구를 떼어 코어의 메시지만 남긴다.
async function call<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(ipcName(channel), ...args)) as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  }
}

const send = (channel: IpcChannel, ...args: unknown[]): void => ipcRenderer.send(ipcName(channel), ...args);

function subscribe<A extends unknown[]>(event: string, cb: (...args: A) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as A));
  ipcRenderer.on(event, listener);
  return () => { ipcRenderer.removeListener(event, listener); };
}

const api: DureApi = {
  projects: {
    list: () => call('projects.list'),
    create: (name) => call('projects.create', name),
    remove: (id) => call('projects.remove', id),
    reopen: (id) => call('projects.reopen', id),
    setAutoShip: (id, mode) => call('projects.setAutoShip', id, mode),
    shipLog: (id) => call('projects.shipLog', id),
    budget: (id) => call('projects.budget', id),
    dashboard: () => call('projects.dashboard'),
    setBudget: (id, daily, total) => call('projects.setBudget', id, daily, total),
    allowToday: (id) => call('projects.allowToday', id),
  },
  coordinator: {
    get: (projectId) => call('coordinator.get', projectId),
    approve: (proposalId, decision) => call('coordinator.approve', proposalId, decision),
    pickSpec: () => call('coordinator.pickSpec'),
    reject: (proposalId, reason) => call('coordinator.reject', proposalId, reason),
    revise: (proposalId, feedback, target, decision) => call('coordinator.revise', proposalId, feedback, target, decision),
  },
  db: {
    list: (projectId) => call('db.list', projectId),
    canStoreSecrets: () => call('db.canStoreSecrets'),
    save: (input) => call('db.save', input),
    remove: (id) => call('db.remove', id),
    test: (id) => call('db.test', id),
    tables: (id, schema) => call('db.tables', id, schema),
    schemas: (id) => call('db.schemas', id),
    columns: (id, schema, table) => call('db.columns', id, schema, table),
    query: (id, sql) => call('db.query', id, sql),
    requests: (projectId) => call('db.requests', projectId),
    decide: (requestId, allow, always) => call('db.decide', requestId, allow, always),
  },
  cleanup: {
    list: (projectId) => call('cleanup.list', projectId),
    restore: (id) => call('cleanup.restore', id),
    export: (id) => call('cleanup.export', id),
    plan: (projectId) => call('cleanup.plan', projectId),
    complete: (projectId, choice) => call('cleanup.complete', projectId, choice),
  },
  repos: {
    list: (projectId) => call('repos.list', projectId),
    pickFolder: () => call('repos.pickFolder'),
    add: (projectId, path) => call('repos.add', projectId, path),
    branches: (repoId) => call('repos.branches', repoId),
    status: (repoId) => call('repos.status', repoId),
    remove: (id) => call('repos.remove', id),
    setVerify: (repoId, command) => call('repos.setVerify', repoId, command),
  },
  verify: {
    statuses: (projectId) => call('verify.statuses', projectId),
    run: (workspaceId) => call('verify.run', workspaceId),
  },
  workspaces: {
    list: (projectId) => call('workspaces.list', projectId),
    create: (input) => call('workspaces.create', input),
    remove: (id, options) => call('workspaces.remove', id, options),
    uncommitted: (id) => call('workspaces.uncommitted', id),
    interrupt: (id) => call('workspaces.interrupt', id),
    stopAgent: (id) => call('workspaces.stopAgent', id),
    setEngine: (id, engine) => call('workspaces.setEngine', id, engine),
    setModel: (id, model) => call('workspaces.setModel', id, model),
    dismissStuck: (id) => call('workspaces.dismissStuck', id),
    rename: (id, name) => call('workspaces.rename', id, name),
    setAutoName: (id, on) => call('workspaces.setAutoName', id, on),
  },
  terminals: {
    list: (workspaceId) => call('terminals.list', workspaceId),
    startAgent: (workspaceId, size) => call('terminals.startAgent', workspaceId, size),
    openShell: (workspaceId, size) => call('terminals.openShell', workspaceId, size),
    write: (id, data) => send('terminals.write', id, data),
    resize: (id, cols, rows) => send('terminals.resize', id, cols, rows),
    kill: (id) => call('terminals.kill', id),
    buffer: (id) => call('terminals.buffer', id),
    onData: (cb) => subscribe<[string, string, number]>(IPC_EVENTS.terminalData, cb),
    onExit: (cb) => subscribe<[string, number]>(IPC_EVENTS.terminalExit, cb),
  },
  todos: {
    list: (projectId) => call('todos.list', projectId),
    add: (input) => call('todos.add', input),
    update: (id, patch) => call('todos.update', id, patch),
    remove: (id) => call('todos.remove', id),
    move: (id, direction) => call('todos.move', id, direction),
    setParent: (id, parentId) => call('todos.setParent', id, parentId),
    setAfter: (id, afterIds) => call('todos.setAfter', id, afterIds),
    pending: (projectId) => call('todos.pending', projectId),
    nudge: (workspaceId) => call('todos.nudge', workspaceId),
  },
  messages: {
    threads: (projectId) => call('messages.threads', projectId),
    list: (threadId) => call('messages.list', threadId),
    send: (input) => call('messages.send', input),
    pauseThread: (threadId, paused) => call('messages.pauseThread', threadId, paused),
    flow: (projectId) => call('messages.flow', projectId),
    pauseProject: (projectId, paused) => call('messages.pauseProject', projectId, paused),
    resume: (projectId) => call('messages.resume', projectId),
    delivery: (projectId) => call('messages.delivery', projectId),
  },
  commit: {
    state: (workspaceId) => call('commit.state', workspaceId),
    diff: (workspaceId, file) => call('commit.diff', workspaceId, file),
    run: (workspaceId, input) => call('commit.run', workspaceId, input),
    push: (workspaceId) => call('commit.push', workspaceId),
  },
  activity: { list: (workspaceId) => call('activity.list', workspaceId) },
  figures: {
    list: (workspaceId) => call('figures.list', workspaceId),
    remove: (id) => call('figures.remove', id),
  },
  agreements: {
    list: (projectId, proposed) => call('agreements.list', projectId, proposed),
    save: (projectId, input) => call('agreements.save', projectId, input),
    accept: (id) => call('agreements.accept', id),
    remove: (id) => call('agreements.remove', id),
  },
  merge: {
    plans: (projectId) => call('merge.plans', projectId),
    prepare: (projectId, repoId, base) => call('merge.prepare', projectId, repoId, base),
    advance: (projectId, repoId, base) => call('merge.advance', projectId, repoId, base),
    askToResolve: (projectId, repoId, base, workspaceId) => call('merge.askToResolve', projectId, repoId, base, workspaceId),
  },
  review: {
    status: (workspaceId) => call('review.status', workspaceId),
    run: (workspaceId) => call('review.run', workspaceId),
    sendToAgent: (workspaceId, picked) => call('review.sendToAgent', workspaceId, picked),
  },
  chat: {
    get: (workspaceId) => call('chat.get', workspaceId),
    step: (workspaceId, stepId) => call('chat.step', workspaceId, stepId),
    send: (workspaceId, text, images) => call('chat.send', workspaceId, text, images),
    answerPermission: (workspaceId, answer, requestId) => call('chat.answerPermission', workspaceId, answer, requestId),
    answerQuestion: (workspaceId, requestId, answers) => call('chat.answerQuestion', workspaceId, requestId, answers),
    dismissQuestion: (workspaceId, requestId) => call('chat.dismissQuestion', workspaceId, requestId),
    commands: (workspaceId) => call('chat.commands', workspaceId),
  },
  doctor: () => call('app.doctor'),
  settings: {
    get: () => call('settings.get'),
    update: (patch) => call('settings.update', patch),
    defaults: () => call('settings.defaults'),
    models: (refresh) => call('settings.models', refresh),
    pickFolder: () => call('settings.pickFolder'),
  },
  artifacts: {
    list: (projectId) => call('artifacts.list', projectId),
    get: (id) => call('artifacts.get', id),
  },
  onChanged: (cb) => subscribe<[ChangeTopic]>(IPC_EVENTS.changed, cb),
  worktime: {
    status: () => call('worktime.status'),
    month: (year, month) => call('worktime.month', year, month),
    clockIn: () => call('worktime.clockIn'),
    clockOut: () => call('worktime.clockOut'),
    rememberCurrent: () => call('worktime.rememberCurrent'),
    forgetNetworks: () => call('worktime.forgetNetworks'),
    removeSession: (id) => call('worktime.removeSession', id),
    editSession: (id, patch) => call('worktime.editSession', id, patch),
    addSession: (startAt, endAt) => call('worktime.addSession', startAt, endAt),
    setBreak: (day, minutes) => call('worktime.setBreak', day, minutes),
  },
  pr: {
    info: (workspaceId) => call('pr.info', workspaceId),
    create: (workspaceId, input) => call('pr.create', workspaceId, input),
    open: (workspaceId, url) => call('pr.open', workspaceId, url),
  },
  checkpoints: {
    list: (workspaceId) => call('checkpoints.list', workspaceId),
    create: (workspaceId, label) => call('checkpoints.create', workspaceId, label),
    preview: (id) => call('checkpoints.preview', id),
    restore: (id) => call('checkpoints.restore', id),
  },
  usage: { summary: (projectId, days) => call('usage.summary', projectId, days) },
  attention: {
    list: () => call('attention.list'),
    onOpen: (cb) => subscribe<[AttentionItem]>(IPC_EVENTS.attentionOpen, cb),
  },
  notes: {
    list: (query) => call('notes.list', query),
    get: (id) => call('notes.get', id),
    create: (input) => call('notes.create', input),
    update: (id, patch) => call('notes.update', id, patch),
    remove: (id) => call('notes.remove', id),
  },
  update: {
    status: () => call('update.status'),
    check: () => call('update.check'),
    apply: () => call('update.apply'),
    dismiss: () => call('update.dismiss'),
  },
  slack: {
    status: () => call('slack.status'),
    connect: (token) => call('slack.connect', token),
    disconnect: () => call('slack.disconnect'),
    setAccess: (access) => call('slack.setAccess', access),
    requests: (projectId) => call('slack.requests', projectId),
    decide: (requestId, allow, always) => call('slack.decide', requestId, allow, always),
  },
  assignments: {
    outgoing: (projectId) => call('assignments.outgoing', projectId),
    incoming: (projectId) => call('assignments.incoming', projectId),
    accept: (id, choices, share) => call('assignments.accept', id, choices, share),
    decline: (id, reason) => call('assignments.decline', id, reason),
    briefs: (projectId) => call('assignments.briefs', projectId),
    takeBrief: (id) => call('assignments.takeBrief', id),
    dropBrief: (id) => call('assignments.dropBrief', id),
    board: (projectId) => call('assignments.board', projectId),
  },
  peers: {
    status: () => call('peers.status'),
    found: () => call('peers.found'),
    list: () => call('peers.list'),
    requests: () => call('peers.requests'),
    connect: (address) => call('peers.connect', address),
    accept: (requestId) => call('peers.accept', requestId),
    dismiss: (requestId) => call('peers.dismiss', requestId),
    setMode: (peerId, mode) => call('peers.setMode', peerId, mode),
    remove: (peerId) => call('peers.remove', peerId),
    share: (projectId) => call('peers.share', projectId),
    createShare: (projectId) => call('peers.createShare', projectId),
    setSuggestMode: (projectId, mode) => call('peers.setSuggestMode', projectId, mode),
    invite: (shareId, peerId, observer) => call('peers.invite', shareId, peerId, observer === true),
    setObserverReports: (projectId, on) => call('peers.setObserverReports', projectId, on),
    invites: () => call('peers.invites'),
    acceptInvite: (inviteId, projectId) => call('peers.acceptInvite', inviteId, projectId),
    declineInvite: (inviteId) => call('peers.declineInvite', inviteId),
    leave: (projectId) => call('peers.leave', projectId),
    removeMember: (shareId, peerId) => call('peers.removeMember', shareId, peerId),
    handOver: (projectId, peerId) => call('peers.handOver', projectId, peerId),
    sharing: (workspaceId) => call('peers.sharing', workspaceId),
    setSharing: (workspaceId, audience, peers) => call('peers.setSharing', workspaceId, audience, peers),
    remote: (projectId) => call('peers.remote', projectId),
    names: () => call('peers.names'),
    held: (projectId) => call('peers.held', projectId),
    pass: (heldId, workspaceId) => call('peers.pass', heldId, workspaceId),
    answer: (heldId, body) => call('peers.answer', heldId, body),
    drop: (heldId) => call('peers.drop', heldId),
  },
  browser: {
    register: (workspaceId, webContentsId) => call('browser.register', workspaceId, webContentsId),
    requests: (projectId) => call('browser.requests', projectId),
    decide: (requestId, allow) => call('browser.decide', requestId, allow),
    onOpen: (cb) => subscribe<[string, string]>(IPC_EVENTS.browserOpen, cb),
  },
};

contextBridge.exposeInMainWorld('dure', api);
