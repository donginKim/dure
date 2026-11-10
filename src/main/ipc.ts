import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { Core } from '@core/index';
import { listBranches } from '@core/git';
import { AgentNotInstalledError, WorktreeMissingError } from '@core/workspaceService';
import { ERROR_PREFIX, IPC_CHANNELS, IPC_EVENTS, IPC_ONE_WAY, ipcName, type ChangeTopic, type IpcChannel, type TerminalSize } from '@shared/ipc';
import type { CreateWorkspaceInput } from '@shared/types';

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
      return listBranches(repo.path);
    },
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
    'terminals.list': (workspaceId: string) => core.pty.list(workspaceId),
    'terminals.startAgent': (workspaceId: string, size: TerminalSize) => core.service.startAgent(workspaceId, size),
    'terminals.openShell': (workspaceId: string, size: TerminalSize) => core.service.openShell(workspaceId, size),
    'terminals.write': (id: string, data: string) => core.pty.write(id, data),
    'terminals.resize': (id: string, cols: number, rows: number) => core.pty.resize(id, cols, rows),
    'terminals.kill': (id: string) => core.pty.kill(id),
    'terminals.buffer': (id: string) => core.pty.buffer(id),
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

  const onData = (id: string, chunk: string): void => broadcast(IPC_EVENTS.terminalData, id, chunk);
  const onExit = (id: string, exitCode: number): void => {
    broadcast(IPC_EVENTS.terminalExit, id, exitCode);
    changed('terminals');
  };
  const onWorkspaceChanged = (): void => { changed('workspaces'); changed('terminals'); };
  core.pty.on('data', onData);
  core.pty.on('exit', onExit);
  core.service.on('changed', onWorkspaceChanged);

  return () => {
    core.pty.off('data', onData);
    core.pty.off('exit', onExit);
    core.service.off('changed', onWorkspaceChanged);
    for (const channel of IPC_CHANNELS) {
      if (IPC_ONE_WAY.includes(channel)) ipcMain.removeAllListeners(ipcName(channel));
      else ipcMain.removeHandler(ipcName(channel));
    }
  };
}
