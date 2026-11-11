import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Repo, RepoStatus } from '@shared/types';
import { openDatabase } from './db';
import { DeliveryService } from './delivery';
import { handleHook, isPermissionPrompt } from './hooks';
import { createGit, type Git } from './git';
import { MessageService } from './messages';
import { startMcpServer } from './mcp/server';
import { artifactTools } from './mcp/tools/artifact';
import { messageTools } from './mcp/tools/message';
import { todoTools } from './mcp/tools/todo';
import { workspaceTools } from './mcp/tools/workspace';
import { PtyManager } from './pty';
import { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import { TodoService } from './todos';
import { WorkspaceService } from './workspaceService';

export interface Core {
  projects: ProjectStore;
  repos: RepoStore;
  workspaces: WorkspaceStore;
  service: WorkspaceService;
  todos: TodoService;
  messages: MessageService;
  delivery: DeliveryService;
  pty: PtyManager;
  git: Git;
  mcpUrl: string;
  addRepo(projectId: string, path: string): Promise<Repo>;
  repoStatus(repoId: string): Promise<RepoStatus>;
  dispose(): Promise<void>;
}

export interface CoreOptions {
  /** SQLite 파일과 워크스페이스별 설정 파일을 두는 폴더 */
  dataDir: string;
  /** worktree 를 만드는 상위 폴더 */
  worktreeRoot: string;
  /** 터미널과 에이전트에 물려줄 환경 (로그인 셸 환경) */
  baseEnv: Record<string, string>;
}

/** 두레 코어를 만든다. 모든 상태의 원본이다. Electron 에 의존하지 않는다. */
export async function createCore(o: CoreOptions): Promise<Core> {
  mkdirSync(o.dataDir, { recursive: true });
  const db = openDatabase(join(o.dataDir, 'dure.db'));
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const workspaces = new WorkspaceStore(db);

  // 지난 실행에서 살아 있던 터미널은 이제 없다. 남은 상태를 되돌린다.
  for (const p of projects.list()) {
    for (const w of workspaces.list(p.id)) {
      if (w.status !== 'stopped') workspaces.update(w.id, { status: 'stopped' });
    }
  }

  const todos = new TodoService(db);
  const messages = new MessageService(db);
  const pty = new PtyManager();
  const git = createGit(o.baseEnv);
  // hook 으로 상태가 바뀌면 서비스의 'changed' 로 내보낸다. 서비스는 MCP 주소가 정해진 뒤에 만들어지므로 나중에 잇는다.
  let onStatus: (workspaceId: string) => void = () => undefined;
  let noteHook: (workspaceId: string, event: string, blocked: boolean) => void = () => undefined;
  const mcp = await startMcpServer({
    workspaces, projects, repos, todos, messages,
    // 전달 엔진은 서비스가 만들어진 뒤에 생긴다. 요청을 처리할 때 읽으므로 그때는 이미 있다.
    get delivery() { return delivery; },
    onHook: (workspace, event, payload) => {
      const out = handleHook({
        workspaces, todos,
        onStatus: (id) => onStatus(id),
        collect: (id) => delivery.collect(id),
        collectMessages: (id) => delivery.collectMessages(id),
        // 사용자가 직접 입력했다: 에이전트끼리의 왕복 횟수를 다시 센다
        onUserPrompt: (w) => messages.userIntervened(w.projectId),
      }, workspace, event, payload);
      // 승인 요청이 아닌 알림(입력을 기다린다는 알림 등)은 에이전트가 일을 시작했다는 뜻이 아니다.
      // 그런 알림 때문에 '쉬는 중 확인' 을 지우면 쉬는 에이전트에게 메시지를 전달하지 못한다.
      if (event !== 'Notification' || isPermissionPrompt(payload)) noteHook(workspace.id, event, out !== '');
      return out;
    },
  }, [workspaceTools, todoTools, messageTools, artifactTools]);
  const service = new WorkspaceService({
    projects, repos, workspaces, pty, todos, messages, git, mcpUrl: mcp.url, hookUrl: mcp.hookUrl, dataDir: o.dataDir, worktreeRoot: o.worktreeRoot, baseEnv: o.baseEnv,
  });

  const delivery: DeliveryService = new DeliveryService({
    workspaces, todos, messages,
    actions: {
      isConfirmedIdle: (id) => service.isConfirmedIdle(id),
      wake: (id, text) => service.wake(id, text),
      start: async (id, prompt) => { await service.startAgent(id, { cols: 120, rows: 40 }, prompt); },
    },
  });
  service.attachDelivery(delivery);
  // 전달은 실패해도(에이전트 종료 등) 메시지가 미전달로 되돌아가므로 여기서는 오류를 삼킨다.
  const kick = (workspaceId: string): void => { delivery.kick(workspaceId).catch(() => undefined); };
  const onSent = (m: { toWorkspaceId: string }): void => kick(m.toWorkspaceId);
  const onReleased = (projectId: string): void => { for (const w of workspaces.list(projectId)) kick(w.id); };
  messages.on('sent', onSent);
  messages.on('released', onReleased);

  onStatus = (id) => service.emit('changed', id);
  noteHook = (id, event, blocked) => service.noteHook(id, event, blocked);

  let disposed = false;
  return {
    projects, repos, workspaces, service, todos, messages, delivery, pty, git, mcpUrl: mcp.url,
    async addRepo(projectId, path) {
      if (!projects.get(projectId)) throw new Error(`프로젝트가 없습니다: ${projectId}`);
      if (!(await git.isGitRepo(path))) throw new Error(`git 저장소가 아닙니다: ${path}`);
      return repos.add(projectId, path);
    },
    async repoStatus(repoId) {
      const repo = repos.get(repoId);
      if (!repo) throw new Error(`저장소가 없습니다: ${repoId}`);
      if (!existsSync(repo.path)) return { ok: false, reason: '폴더를 찾을 수 없습니다.' };
      if (!(await git.isGitRepo(repo.path))) return { ok: false, reason: 'git 저장소가 아닙니다.' };
      return { ok: true, branch: await git.currentBranch(repo.path) };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      messages.off('sent', onSent);
      messages.off('released', onReleased);
      service.detach();
      await pty.killAll();
      await mcp.close();
      db.close();
    },
  };
}
