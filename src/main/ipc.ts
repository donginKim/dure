import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import { isTerminalReply } from '@core/agents/trustPrompt';
import type { Core } from '@core/index';
import { AgentNotInstalledError, WorktreeMissingError } from '@core/workspaceService';
import { ERROR_PREFIX, IPC_CHANNELS, IPC_EVENTS, IPC_ONE_WAY, ipcName, type ChangeTopic, type IpcChannel, type TerminalSize } from '@shared/ipc';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { CompletionChoice, CreateWorkspaceInput, PlanDecision, Settings, TodoAssignee, TodoPatch, DbConnectionInput, PeerMode, SharingAudience, AssignChoice, SlackAccess, AttentionItem } from '@shared/types';

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
    'coordinator.get': (projectId: string) => ({ workspace: core.coordinator.ensure(projectId), proposal: core.coordinator.pending(projectId), newRepoDir: core.coordinator.newRepoDir(projectId), people: core.peers.assignable(projectId) }),
    'coordinator.approve': (proposalId: string, decision: PlanDecision) => core.coordinator.approve(proposalId, decision),
    'coordinator.pickSpec': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '기획서 파일 선택' });
      return res.canceled || res.filePaths.length === 0 ? null : core.coordinator.readSpec(res.filePaths[0]!);
    },
    'coordinator.reject': (proposalId: string, reason?: string) => core.coordinator.reject(proposalId, reason),
    'pr.info': (workspaceId: string) => core.prs.info(String(workspaceId)),
    'pr.create': (workspaceId: string, input: { title: string; body: string }) => core.prs.create(String(workspaceId), { title: String(input?.title ?? ''), body: String(input?.body ?? '') }),
    'pr.open': async (workspaceId: string, url?: string) => {
      // 여는 주소는 그 워크스페이스의 원격 저장소 아래의 것만이다 (화면이 아무 주소나 열게 하지 않는다).
      const info = await core.prs.info(String(workspaceId));
      const base = info.url ? new URL(info.url).origin : null;
      const target = url && base && String(url).startsWith(`${base}/`) ? String(url) : info.url;
      if (!target) throw new Error('이 원격 저장소의 PR 화면을 알 수 없습니다.');
      await shell.openExternal(target);
    },
    'checkpoints.list': (workspaceId: string) => core.checkpoints.list(String(workspaceId)),
    'checkpoints.create': (workspaceId: string, label?: string) => core.checkpoints.create(String(workspaceId), String(label ?? '') || '직접 만든 지점', 'manual'),
    'checkpoints.preview': (id: string) => core.checkpoints.preview(String(id)),
    'checkpoints.restore': (id: string) => core.checkpoints.restore(String(id)),
    'usage.summary': (projectId: string, days?: number) => core.usage.summary(String(projectId), Number(days) > 0 ? Date.now() - Number(days) * 86_400_000 : 0),
    'attention.list': () => core.attention.list(),
    'notes.list': (query?: string) => core.notes.list(String(query ?? '')),
    'notes.get': (id: string) => core.notes.get(String(id)) ?? null,
    'notes.create': (input?: { title?: string; body?: string }) => core.notes.create(input ?? {}),
    'notes.update': (id: string, patch: { title?: string; body?: string }) => core.notes.update(String(id), patch ?? {}),
    'notes.remove': (id: string) => core.notes.remove(String(id)),
    'update.status': () => core.updates.status(),
    'update.check': () => core.updates.check(),
    'update.apply': () => {
      core.updates.apply();
      // 스크립트는 앱이 꺼지기를 기다린다. 응답이 화면에 닿은 뒤에 끈다 (에이전트와 터미널은 종료 과정에서 정리된다).
      setTimeout(() => app.quit(), 300);
    },
    'update.dismiss': () => core.updates.dismissLast(),
    'slack.status': () => core.slack.status(),
    'slack.connect': (token: string) => core.slack.connect(String(token ?? '')),
    'slack.disconnect': () => core.slack.disconnect(),
    'slack.setAccess': (access: SlackAccess) => core.slack.setAccess(access),
    'slack.requests': (projectId: string) => core.slack.pending(String(projectId)),
    'slack.decide': (requestId: string, allow: boolean, always?: boolean) => core.slack.decide(String(requestId), allow === true, { always: always === true }),
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
    'assignments.outgoing': (projectId: string) => core.assignments.outgoing(String(projectId)),
    'assignments.incoming': (projectId?: string) => core.assignments.incoming(projectId ? String(projectId) : undefined),
    'assignments.accept': (id: string, choices: AssignChoice[], share: boolean) => core.assignments.accept(String(id), Array.isArray(choices) ? choices : [], { share: share !== false }),
    'assignments.decline': (id: string, reason?: string) => core.assignments.decline(String(id), reason),
    'assignments.briefs': (projectId: string) => core.assignments.briefs(String(projectId)),
    'assignments.takeBrief': (id: string) => core.assignments.takeBrief(String(id)),
    'assignments.dropBrief': (id: string) => core.assignments.dropBrief(String(id)),
    'peers.status': () => core.peers.status(),
    'peers.found': () => core.peers.found(),
    'peers.list': () => core.peers.peers(),
    'peers.requests': () => core.peers.requests(),
    'peers.connect': (address: string) => core.peers.connect(String(address)),
    'peers.accept': (requestId: string) => core.peers.accept(String(requestId)),
    'peers.dismiss': (requestId: string) => core.peers.dismiss(String(requestId)),
    'peers.setMode': (peerId: string, mode: PeerMode) => core.peers.setMode(String(peerId), mode),
    'peers.remove': (peerId: string) => core.peers.removePeer(String(peerId)),
    'peers.share': (projectId: string) => core.peers.share(String(projectId)),
    'peers.createShare': (projectId: string) => core.peers.createShare(String(projectId)),
    'peers.invite': (shareId: string, peerId: string) => core.peers.invite(String(shareId), String(peerId)),
    'peers.invites': () => core.peers.shareInvites(),
    'peers.acceptInvite': (inviteId: string, projectId: string) => core.peers.acceptInvite(String(inviteId), String(projectId)),
    'peers.declineInvite': (inviteId: string) => core.peers.declineInvite(String(inviteId)),
    'peers.leave': (projectId: string) => core.peers.leave(String(projectId)),
    'peers.removeMember': (shareId: string, peerId: string) => core.peers.removeMember(String(shareId), String(peerId)),
    'peers.sharing': (workspaceId: string) => core.peers.sharing(String(workspaceId)),
    'peers.setSharing': (workspaceId: string, audience: SharingAudience, peers: string[]) => core.peers.setSharing(String(workspaceId), audience, Array.isArray(peers) ? peers.map(String) : []),
    'peers.remote': (projectId: string) => core.peers.remoteWorkspaces(String(projectId)),
    'peers.names': () => core.peers.remoteNames(),
    'peers.held': (projectId: string) => core.peers.held(String(projectId)),
    'peers.pass': (heldId: string, workspaceId?: string) => core.peers.pass(String(heldId), workspaceId ? String(workspaceId) : undefined),
    'peers.answer': (heldId: string, body: string) => core.peers.answer(String(heldId), String(body ?? '')),
    'peers.drop': (heldId: string) => core.peers.drop(String(heldId)),
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
    'chat.send': async (workspaceId: string, text: string, images?: unknown) => {
      // 에이전트에게 시키기 직전의 모습을 적어 둔다 (되돌리기 지점). 못 적어도 보내기는 한다.
      const ws = core.workspaces.get(workspaceId);
      if (ws && ws.role !== 'coordinator' && !String(text ?? '').trim().startsWith('/')) await core.checkpoints.create(workspaceId, String(text ?? ''), 'auto').catch(() => undefined);
      return core.service.sendUserInput(workspaceId, text, images);
    },
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
  const onSlackChanged = (): void => changed('slack');
  const onUpdateChanged = (): void => changed('update');
  const onNotesChanged = (): void => changed('notes');
  const onCheckpointsChanged = (): void => changed('checkpoints');
  // 확인할 것: Dock 아이콘에 수를 적고, 새로 생기면 알림을 띄운다 (두레를 보고 있을 때는 띄우지 않는다).
  const onAttentionChanged = (): void => {
    changed('attention');
    const n = core.attention.list().length;
    app.dock?.setBadge(n > 0 ? String(n) : '');
  };
  const onAttentionAdded = (items: AttentionItem[]): void => {
    if (!core.settings.get().notifications || !Notification.isSupported()) return;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win?.isFocused()) return;
    // 한꺼번에 여럿 생기면 하나로 묶는다.
    const first = items[0]!;
    const note = new Notification({
      title: items.length > 1 ? `두레 · 확인할 것 ${items.length}건` : `두레${first.projectName ? ` · ${first.projectName}` : ''}`,
      body: items.length > 1 ? items.slice(0, 3).map((i) => i.title).join('\n') : `${first.title}${first.detail ? `\n${first.detail}` : ''}`,
    });
    note.on('click', () => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      w.webContents.send(IPC_EVENTS.attentionOpen, first);
    });
    note.show();
  };
  const onBrowserChanged = (): void => changed('browser');
  const onPeersChanged = (): void => changed('peers');
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
  core.slack.on('changed', onSlackChanged);
  core.updates.on('changed', onUpdateChanged);
  core.notes.on('changed', onNotesChanged);
  core.checkpoints.on('changed', onCheckpointsChanged);
  core.attention.on('changed', onAttentionChanged);
  core.attention.on('added', onAttentionAdded);
  core.browser.on('changed', onBrowserChanged);
  core.peers.on('changed', onPeersChanged);
  core.assignments.on('changed', onPeersChanged);
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
    core.slack.off('changed', onSlackChanged);
    core.updates.off('changed', onUpdateChanged);
    core.notes.off('changed', onNotesChanged);
    core.checkpoints.off('changed', onCheckpointsChanged);
    core.attention.off('changed', onAttentionChanged);
    core.attention.off('added', onAttentionAdded);
    core.browser.off('changed', onBrowserChanged);
    core.peers.off('changed', onPeersChanged);
    core.assignments.off('changed', onPeersChanged);
    core.coordinator.off('changed', onCoordinatorChanged);
    core.settings.off('changed', onSettingsChanged);
    core.engine.off('changed', onChatChanged);
    for (const channel of IPC_CHANNELS) {
      if (IPC_ONE_WAY.includes(channel)) ipcMain.removeAllListeners(ipcName(channel));
      else ipcMain.removeHandler(ipcName(channel));
    }
  };
}
