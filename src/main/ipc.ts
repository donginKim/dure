import { BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { isTerminalReply } from '@core/agents/trustPrompt';
import type { Core } from '@core/index';
import { AgentNotInstalledError, WorktreeMissingError } from '@core/workspaceService';
import { ERROR_PREFIX, IPC_CHANNELS, IPC_EVENTS, IPC_ONE_WAY, ipcName, type ChangeTopic, type IpcChannel, type TerminalSize } from '@shared/ipc';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { CompletionChoice, CreateWorkspaceInput, PlanDecision, Settings, TodoAssignee, TodoPatch, DbConnectionInput } from '@shared/types';

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
export function registerIpc(core: Core, browser: { register(workspaceId: string, webContentsId: number): void }): () => void {
  const changed = (topic: ChangeTopic): void => broadcast(IPC_EVENTS.changed, topic);

  // 완료된 프로젝트는 기록만 본다.
  const assertTodoOpen = (todoId: string): undefined => {
    const t = core.todos.get(todoId);
    return t ? assertOpen(t.projectId) : undefined;
  };
  const assertOpen = (projectId: string): undefined => {
    if (core.service.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다. 다시 열어야 바꿀 수 있습니다.');
    return undefined;
  };

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
      await core.removeProject(id);
      changed('projects');
    },
    'projects.reopen': (id: string) => { const p = core.reopenProject(id); changed('projects'); return p; },
    'coordinator.get': (projectId: string) => ({ workspace: core.coordinator.ensure(projectId), proposal: core.coordinator.pending(projectId), newRepoDir: core.coordinator.newRepoDir(projectId) }),
    'coordinator.approve': (proposalId: string, decision: PlanDecision) => core.coordinator.approve(proposalId, decision),
    'coordinator.pickSpec': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '기획서 파일 선택' });
      return res.canceled || res.filePaths.length === 0 ? null : core.coordinator.readSpec(res.filePaths[0]!);
    },
    'coordinator.reject': (proposalId: string, reason?: string) => core.coordinator.reject(proposalId, reason),
    'db.list': (projectId: string) => core.dbs.list(projectId),
    'db.canStoreSecrets': () => safeStorage.isEncryptionAvailable(),
    'db.save': (input: DbConnectionInput) => core.dbs.save(input),
    'db.remove': (id: string) => core.dbs.remove(id),
    'db.test': (id: string) => core.dbs.test(id),
    'db.tables': (id: string) => core.dbs.tables(id),
    'db.columns': (id: string, schema: string, table: string) => core.dbs.columns(id, schema, table),
    'db.query': (id: string, sql: string) => core.dbs.query(id, sql),
    'db.requests': (projectId: string) => core.dbs.pending(projectId),
    'db.decide': (requestId: string, allow: boolean, always?: boolean) => core.dbs.decide(requestId, allow === true, { always: always === true }),
    'cleanup.list': (projectId: string) => core.cleanup.list(projectId),
    'cleanup.restore': (id: string) => core.cleanup.restore(id),
    'cleanup.export': async (id: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '꺼낼 폴더 선택' });
      return res.canceled || res.filePaths.length === 0 ? null : core.cleanup.exportTo(id, res.filePaths[0]!);
    },
    'cleanup.plan': (projectId: string) => core.completionPlan(projectId),
    'cleanup.complete': async (projectId: string, choice: CompletionChoice) => {
      try { return await core.completeProject(projectId, choice); } finally { changed('projects'); changed('cleanup'); }
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
    'workspaces.list': (projectId: string) => core.workspaces.listAll(projectId),
    'workspaces.create': (input: CreateWorkspaceInput) => core.service.create(input),
    'workspaces.remove': (id: string, options: { deleteWorktree: boolean }) => core.service.remove(id, { deleteWorktree: Boolean(options?.deleteWorktree) }),
    'workspaces.uncommitted': (id: string) => core.service.uncommittedCount(id),
    'workspaces.interrupt': (id: string) => core.service.interrupt(id),
    'workspaces.stopAgent': (id: string) => core.service.stopAgent(id),
    'workspaces.setEngine': (id: string, engine: 'chat' | 'terminal') => core.service.setEngine(id, engine),
    'workspaces.rename': (id: string, name: string) => core.service.rename(id, name),
    'workspaces.setAutoName': (id: string, on: boolean) => core.service.setAutoName(id, on === true),
    'terminals.list': (workspaceId: string) => core.pty.listWithExited(workspaceId),
    'terminals.startAgent': (workspaceId: string, size: TerminalSize) => core.service.startAgent(workspaceId, size),
    'terminals.openShell': (workspaceId: string, size: TerminalSize) => core.service.openShell(workspaceId, size),
    'terminals.write': (id: string, data: string) => {
      // 사용자가 에이전트 터미널에 입력하고 있다: 두레가 그 터미널에 글을 써 넣으면 안 된다.
      // 화면이 스스로 돌려보내는 응답(터미널 버전, 커서 위치 등)은 사용자가 누른 키가 아니다.
      if (!isTerminalReply(data)) core.service.noteTerminalInput(id);
      core.pty.write(id, data);
    },
    'terminals.resize': (id: string, cols: number, rows: number) => core.pty.resize(id, cols, rows),
    'terminals.kill': (id: string) => { core.pty.kill(id); changed('terminals'); },
    'terminals.buffer': (id: string) => core.pty.snapshot(id),
    // 화면에서 온 TODO 변경은 모두 사용자의 변경이다.
    'todos.list': (projectId: string) => core.todos.listProject(projectId),
    'todos.add': (i: { projectId: string; workspaceId: string | null; title: string; assignee?: TodoAssignee }) => { assertOpen(i.projectId); return core.todos.add(i, 'user'); },
    'todos.update': (id: string, patch: TodoPatch) => assertTodoOpen(id) ?? core.todos.update(id, patch, { actor: 'user' }),
    'todos.remove': (id: string) => assertTodoOpen(id) ?? core.todos.remove(id, { actor: 'user' }),
    'todos.move': (id: string, direction: 'up' | 'down') => assertTodoOpen(id) ?? core.todos.move(id, direction),
    'todos.pending': (projectId: string) => Object.fromEntries(
      core.workspaces.listAll(projectId).map((w) => [w.id, { count: core.todos.pendingCount(w.id), canNudge: core.service.canNudge(w.id) }]),
    ),
    'todos.nudge': (workspaceId: string) => core.service.nudge(workspaceId),
    'messages.threads': (projectId: string) => core.messages.threads(projectId),
    'messages.list': (threadId: string) => core.messages.messages(threadId),
    // 화면에서 보낸 메시지는 사용자가 보낸 것이다.
    'messages.send': (i: { projectId: string; toWorkspaceId: string; body: string; threadId?: string }) =>
      assertOpen(i.projectId) ?? core.messages.send({ projectId: i.projectId, from: { kind: 'user' }, toWorkspaceId: i.toWorkspaceId, body: i.body, threadId: i.threadId }),
    'messages.pauseThread': (threadId: string, paused: boolean) => core.messages.pauseThread(threadId, paused),
    'messages.flow': (projectId: string) => core.messages.flow(projectId),
    'messages.pauseProject': (projectId: string, paused: boolean) => {
      core.messages.pauseProject(projectId, paused);
      // 전체 멈춤은 전달만 막는 것이 아니라 하던 일도 멈춘다.
      // 조율 에이전트도 멈춘다.
      if (paused) for (const w of core.workspaces.listAll(projectId)) core.service.interrupt(w.id);
    },
    'messages.resume': (projectId: string) => core.messages.userIntervened(projectId),
    'messages.delivery': (projectId: string) => Object.fromEntries(core.workspaces.listAll(projectId).map((w) => [w.id, {
      state: core.delivery.state(w.id),
      waiting: core.messages.undelivered(w.id).length,
      held: core.messages.heldCount(w.id),
      error: core.delivery.error(w.id),
    }])),
    'browser.register': (workspaceId: string, webContentsId: number) => {
      if (!core.workspaces.get(String(workspaceId))) throw new Error('워크스페이스가 없습니다.');
      browser.register(String(workspaceId), Number(webContentsId));
    },
    'browser.requests': (projectId: string) => core.browser.pending(projectId),
    'browser.decide': (requestId: string, allow: boolean) => core.browser.decide(String(requestId), allow === true),
    'commit.state': (workspaceId: string) => core.commit.state(workspaceId),
    'commit.diff': (workspaceId: string, file: string) => core.commit.diff(workspaceId, String(file)),
    'commit.run': (workspaceId: string, input: { files: string[]; message: string }) => core.commit.commit(workspaceId, input),
    'commit.push': (workspaceId: string) => core.commit.push(workspaceId),
    'settings.get': () => core.settings.get(),
    'settings.update': (patch: Partial<Settings>) => core.settings.update(patch),
    'settings.defaults': () => ({ ...DEFAULT_SETTINGS }),
    'settings.models': (refresh?: boolean) => core.models(refresh === true),
    'settings.pickFolder': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '폴더 선택' });
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    },
    'chat.get': (workspaceId: string) => core.chatView(workspaceId),
    'chat.step': (workspaceId: string, stepId: string) => core.chat.step(workspaceId, stepId),
    'chat.send': (workspaceId: string, text: string) => core.service.sendUserInput(workspaceId, text),
    'chat.answerPermission': (workspaceId: string, answer: 'allow' | 'deny' | 'always', requestId?: string) => core.service.answerPermission(workspaceId, answer, requestId),
    'chat.answerQuestion': (workspaceId: string, requestId: string, answers: Record<string, string>) => core.service.answerQuestion(workspaceId, requestId, answers),
    'chat.dismissQuestion': (workspaceId: string, requestId: string) => core.service.dismissQuestion(workspaceId, requestId),
    'chat.commands': (workspaceId: string) => core.slashCommands(workspaceId),
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
  const onWorkspaceChanged = (): void => { changed('workspaces'); changed('terminals'); changed('todos'); changed('messages'); changed('chat'); };
  const onChatChanged = (): void => changed('chat');
  const onCleanupChanged = (): void => changed('cleanup');
  const onDbChanged = (): void => changed('db');
  const onBrowserChanged = (): void => changed('browser');
  // 승인으로 새 저장소가 등록될 수 있다.
  const onCoordinatorChanged = (): void => { changed('coordinator'); changed('repos'); };
  // 설정이 바뀌면 전달 방식(메시지로 띄우기)도 바뀌므로 messages 도 함께 알린다.
  const onSettingsChanged = (): void => { changed('settings'); changed('messages'); };
  const onMessagesChanged = (): void => changed('messages');
  const onCommitChanged = (): void => changed('commit');
  const onTodosChanged = (): void => changed('todos');
  core.pty.on('data', onData);
  core.pty.on('exit', onExit);
  core.service.on('changed', onWorkspaceChanged);
  core.todos.on('changed', onTodosChanged);
  core.todos.on('delivered', onTodosChanged);
  core.messages.on('changed', onMessagesChanged);
  core.commit.on('changed', onCommitChanged);
  core.chat.on('changed', onChatChanged);
  core.cleanup.on('changed', onCleanupChanged);
  core.dbs.on('changed', onDbChanged);
  core.browser.on('changed', onBrowserChanged);
  core.coordinator.on('changed', onCoordinatorChanged);
  core.settings.on('changed', onSettingsChanged);
  core.engine.on('changed', onChatChanged);

  return () => {
    core.pty.off('data', onData);
    core.pty.off('exit', onExit);
    core.service.off('changed', onWorkspaceChanged);
    core.todos.off('changed', onTodosChanged);
    core.todos.off('delivered', onTodosChanged);
    core.messages.off('changed', onMessagesChanged);
    core.commit.off('changed', onCommitChanged);
    core.chat.off('changed', onChatChanged);
    core.cleanup.off('changed', onCleanupChanged);
    core.dbs.off('changed', onDbChanged);
    core.browser.off('changed', onBrowserChanged);
    core.coordinator.off('changed', onCoordinatorChanged);
    core.settings.off('changed', onSettingsChanged);
    core.engine.off('changed', onChatChanged);
    for (const channel of IPC_CHANNELS) {
      if (IPC_ONE_WAY.includes(channel)) ipcMain.removeAllListeners(ipcName(channel));
      else ipcMain.removeHandler(ipcName(channel));
    }
  };
}
