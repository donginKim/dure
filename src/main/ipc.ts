import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { Core } from '@core/index';
import { AgentNotInstalledError, WorktreeMissingError } from '@core/workspaceService';
import { ERROR_PREFIX, IPC_CHANNELS, IPC_EVENTS, IPC_ONE_WAY, ipcName, type ChangeTopic, type IpcChannel, type TerminalSize } from '@shared/ipc';
import type { CreateWorkspaceInput, TodoAssignee, TodoPatch } from '@shared/types';

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

function tagged(e: unknown): Error {
  if (e instanceof AgentNotInstalledError) return new Error(`${ERROR_PREFIX.agentNotInstalled}${e.kind}:${e.message}`);
  if (e instanceof WorktreeMissingError) return new Error(`${ERROR_PREFIX.worktreeMissing}${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

/** 코어를 IPC 로 화면에 내보낸다. 돌려주는 함수는 등록을 해제한다. */
export function registerIpc(core: Core): () => void {
  const changed = (topic: ChangeTopic): void => broadcast(IPC_EVENTS.changed, topic);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: Record<IpcChannel, (...args: any[]) => unknown> = {
    'projects.list': () => core.projects.list(),
    'projects.create': (name: string) => {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) throw new Error('프로젝트 이름을 입력하세요.');
      const p = core.projects.create(trimmed);
      changed('projects');
      return p;
    },
    'projects.remove': async (id: string) => {
      // 프로젝트의 워크스페이스는 터미널만 끄고 작업 폴더는 남긴다.
      for (const ws of core.workspaces.list(id)) await core.service.remove(ws.id, { deleteWorktree: false });
      core.projects.remove(id);
      changed('projects');
    },
    'repos.list': (projectId: string) => core.repos.list(projectId),
    'repos.pickFolder': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '저장소 폴더 선택' });
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    },
    'repos.add': async (projectId: string, path: string) => {
      const r = await core.addRepo(projectId, path);
      changed('repos');
      return r;
    },
    'repos.branches': (repoId: string) => {
      const repo = core.repos.get(repoId);
      if (!repo) throw new Error(`저장소가 없습니다: ${repoId}`);
      return core.git.listBranches(repo.path);
    },
    'repos.status': (repoId: string) => core.repoStatus(repoId),
    'repos.remove': (id: string) => {
      try {
        core.repos.remove(id);
      } catch {
        throw new Error('이 저장소를 쓰는 워크스페이스가 있어 지울 수 없습니다.');
      }
      changed('repos');
    },
    'workspaces.list': (projectId: string) => core.workspaces.list(projectId),
    'workspaces.create': (input: CreateWorkspaceInput) => core.service.create(input),
    'workspaces.remove': (id: string, options: { deleteWorktree: boolean }) => core.service.remove(id, options),
    'workspaces.uncommitted': (id: string) => core.service.uncommittedCount(id),
    'workspaces.interrupt': (id: string) => core.service.interrupt(id),
    'terminals.list': (workspaceId: string) => core.pty.listWithExited(workspaceId),
    'terminals.startAgent': (workspaceId: string, size: TerminalSize) => core.service.startAgent(workspaceId, size),
    'terminals.openShell': (workspaceId: string, size: TerminalSize) => core.service.openShell(workspaceId, size),
    'terminals.write': (id: string, data: string) => core.pty.write(id, data),
    'terminals.resize': (id: string, cols: number, rows: number) => core.pty.resize(id, cols, rows),
    'terminals.kill': (id: string) => { core.pty.kill(id); changed('terminals'); },
    'terminals.buffer': (id: string) => core.pty.snapshot(id),
    // 화면에서 온 TODO 변경은 모두 사용자의 변경이다.
    'todos.list': (projectId: string) => core.todos.listProject(projectId),
    'todos.add': (i: { projectId: string; workspaceId: string | null; title: string; assignee?: TodoAssignee }) => core.todos.add(i, 'user'),
    'todos.update': (id: string, patch: TodoPatch) => core.todos.update(id, patch, { actor: 'user' }),
    'todos.remove': (id: string) => core.todos.remove(id, { actor: 'user' }),
    'todos.move': (id: string, direction: 'up' | 'down') => core.todos.move(id, direction),
    'todos.pending': (projectId: string) => Object.fromEntries(
      core.workspaces.list(projectId).map((w) => [w.id, { count: core.todos.pendingCount(w.id), canNudge: core.service.canNudge(w.id) }]),
    ),
    'todos.nudge': (workspaceId: string) => core.service.nudge(workspaceId),
    'messages.threads': (projectId: string) => core.messages.threads(projectId),
    'messages.list': (threadId: string) => core.messages.messages(threadId),
    // 화면에서 보낸 메시지는 사용자가 보낸 것이다.
    'messages.send': (i: { projectId: string; toWorkspaceId: string; body: string; threadId?: string }) =>
      core.messages.send({ projectId: i.projectId, from: { kind: 'user' }, toWorkspaceId: i.toWorkspaceId, body: i.body, threadId: i.threadId }),
    'messages.pauseThread': (threadId: string, paused: boolean) => core.messages.pauseThread(threadId, paused),
    'messages.flow': (projectId: string) => core.messages.flow(projectId),
    'messages.pauseProject': (projectId: string, paused: boolean) => {
      core.messages.pauseProject(projectId, paused);
      // 전체 멈춤은 전달만 막는 것이 아니라 하던 일도 멈춘다.
      if (paused) for (const w of core.workspaces.list(projectId)) core.service.interrupt(w.id);
    },
    'messages.resume': (projectId: string) => core.messages.userIntervened(projectId),
    'messages.delivery': (projectId: string) => Object.fromEntries(core.workspaces.list(projectId).map((w) => [w.id, {
      state: core.delivery.state(w.id),
      waiting: core.messages.undelivered(w.id).length,
      held: core.messages.heldCount(w.id),
    }])),
    'artifacts.list': (projectId: string) => core.messages.artifacts(projectId),
    'artifacts.get': (id: string) => core.messages.artifact(id) ?? null,
  };

  for (const channel of IPC_CHANNELS) {
    const handler = handlers[channel];
    if (IPC_ONE_WAY.includes(channel)) {
      ipcMain.on(ipcName(channel), (_e, ...args) => { handler(...args); });
    } else {
      ipcMain.handle(ipcName(channel), async (_e, ...args) => {
        try {
          return await handler(...args);
        } catch (e) {
          throw tagged(e);
        }
      });
    }
  }

  const onData = (id: string, chunk: string, end: number): void => broadcast(IPC_EVENTS.terminalData, id, chunk, end);
  const onExit = (id: string, exitCode: number): void => {
    broadcast(IPC_EVENTS.terminalExit, id, exitCode);
    changed('terminals');
  };
  // 상태가 바뀌면 '알리기' 가능 여부도 바뀌므로 todos 도 함께 알린다.
  // 상태가 바뀌면 전달 방식도 바뀌므로 messages 도 함께 알린다.
  const onWorkspaceChanged = (): void => { changed('workspaces'); changed('terminals'); changed('todos'); changed('messages'); };
  const onMessagesChanged = (): void => changed('messages');
  const onTodosChanged = (): void => changed('todos');
  core.pty.on('data', onData);
  core.pty.on('exit', onExit);
  core.service.on('changed', onWorkspaceChanged);
  core.todos.on('changed', onTodosChanged);
  core.todos.on('delivered', onTodosChanged);
  core.messages.on('changed', onMessagesChanged);

  return () => {
    core.pty.off('data', onData);
    core.pty.off('exit', onExit);
    core.service.off('changed', onWorkspaceChanged);
    core.todos.off('changed', onTodosChanged);
    core.todos.off('delivered', onTodosChanged);
    core.messages.off('changed', onMessagesChanged);
    for (const channel of IPC_CHANNELS) {
      if (IPC_ONE_WAY.includes(channel)) ipcMain.removeAllListeners(ipcName(channel));
      else ipcMain.removeHandler(ipcName(channel));
    }
  };
}
