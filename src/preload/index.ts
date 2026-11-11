import { contextBridge, ipcRenderer } from 'electron';
import { IPC_EVENTS, ipcName, type ChangeTopic, type DureApi, type IpcChannel } from '@shared/ipc';

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
  },
  coordinator: {
    get: (projectId) => call('coordinator.get', projectId),
    approve: (proposalId, decision) => call('coordinator.approve', proposalId, decision),
    pickSpec: () => call('coordinator.pickSpec'),
    reject: (proposalId, reason) => call('coordinator.reject', proposalId, reason),
  },
  db: {
    list: (projectId) => call('db.list', projectId),
    canStoreSecrets: () => call('db.canStoreSecrets'),
    save: (input) => call('db.save', input),
    remove: (id) => call('db.remove', id),
    test: (id) => call('db.test', id),
    tables: (id) => call('db.tables', id),
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
  },
  workspaces: {
    list: (projectId) => call('workspaces.list', projectId),
    create: (input) => call('workspaces.create', input),
    remove: (id, options) => call('workspaces.remove', id, options),
    uncommitted: (id) => call('workspaces.uncommitted', id),
    interrupt: (id) => call('workspaces.interrupt', id),
    stopAgent: (id) => call('workspaces.stopAgent', id),
    setEngine: (id, engine) => call('workspaces.setEngine', id, engine),
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
  chat: {
    get: (workspaceId) => call('chat.get', workspaceId),
    step: (workspaceId, stepId) => call('chat.step', workspaceId, stepId),
    send: (workspaceId, text) => call('chat.send', workspaceId, text),
    answerPermission: (workspaceId, answer, requestId) => call('chat.answerPermission', workspaceId, answer, requestId),
    answerQuestion: (workspaceId, requestId, answers) => call('chat.answerQuestion', workspaceId, requestId, answers),
    dismissQuestion: (workspaceId, requestId) => call('chat.dismissQuestion', workspaceId, requestId),
    commands: (workspaceId) => call('chat.commands', workspaceId),
  },
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
};

contextBridge.exposeInMainWorld('dure', api);
