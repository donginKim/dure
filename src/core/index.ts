import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Repo, RepoStatus } from '@shared/types';
import { ChatService } from './chat/chatService';
import { ChatEngine } from './chat/engine';
import type { ChatView, SlashCommand } from '@shared/types';
import { CommitDraftStore } from './commitDrafts';
import { CommitService } from './commitService';
import { openDatabase } from './db';
import { DeliveryService } from './delivery';
import { handleHook, isPermissionPrompt } from './hooks';
import { createGit, type Git } from './git';
import { MessageService } from './messages';
import { startMcpServer } from './mcp/server';
import { artifactTools } from './mcp/tools/artifact';
import { commitTools } from './mcp/tools/commit';
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
  chat: ChatService;
  engine: ChatEngine;
  /** 채팅 화면이 받는 것: 대화, 쓰는 중인 글, 승인·질문 대기 */
  chatView(workspaceId: string): ChatView;
  slashCommands(workspaceId: string): SlashCommand[];
  commitDrafts: CommitDraftStore;
  commit: CommitService;
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
  /** Claude Code 가 대화 기록을 두는 폴더. 기본 ~/.claude */
  claudeDir?: string;
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
  const commitDrafts = new CommitDraftStore(db);
  const pty = new PtyManager();
  const git = createGit(o.baseEnv);
  // hook 으로 상태가 바뀌면 서비스의 'changed' 로 내보낸다. 서비스는 MCP 주소가 정해진 뒤에 만들어지므로 나중에 잇는다.
  let onStatus: (workspaceId: string) => void = () => undefined;
  let noteHook: (workspaceId: string, event: string, blocked: boolean) => void = () => undefined;
  const chat = new ChatService({ workspaces, // Claude Code 는 CLAUDE_CONFIG_DIR 가 있으면 그 폴더에 대화 기록을 둔다. 에이전트가 물려받는 환경과 같은 값을 쓴다.
    allowedRoot: o.claudeDir ?? [o.baseEnv.CLAUDE_CONFIG_DIR ?? '', join(homedir(), '.claude')], onInterrupted: (id) => service.noteInterrupted(id) });
  const mcp = await startMcpServer({
    workspaces, projects, repos, todos, messages, commitDrafts,
    // 전달 엔진은 서비스가 만들어진 뒤에 생긴다. 요청을 처리할 때 읽으므로 그때는 이미 있다.
    get delivery() { return delivery; },
    onHook: (workspace, event, payload) => {
      const out = handleHook({
        workspaces, todos,
        onStatus: (id) => onStatus(id),
        // 작업 중에 채팅으로 보낸 글이 먼저다. TODO 변경과 메시지가 그 뒤에 붙는다.
        collect: (id) => {
          const parts = [chat.takeQueued(id), delivery.collect(id)].filter((x): x is string => Boolean(x));
          return parts.length ? parts.join('\n\n') : undefined;
        },
        collectMessages: (id) => delivery.collectMessages(id),
        onUserPrompt: (w) => {
          // 첫 프롬프트로 건넨 메시지는 에이전트가 프롬프트를 받은 지금 전달이 확정된다.
          delivery.confirmStart(w.id);
          // 두레가 넣은 프롬프트가 아니면 사용자가 직접 입력한 것이다: 에이전트끼리의 왕복 횟수를 다시 센다.
          if (!service.consumeSynthetic(w.id)) messages.userIntervened(w.projectId);
        },
      }, workspace, event, payload);
      // 승인 요청이 아닌 알림(입력을 기다린다는 알림 등)은 에이전트가 일을 시작했다는 뜻이 아니다.
      // 그런 알림 때문에 '쉬는 중 확인' 을 지우면 쉬는 에이전트에게 메시지를 전달하지 못한다.
      if (event !== 'Notification' || isPermissionPrompt(payload)) noteHook(workspace.id, event, out !== '');
      // 채팅 보기는 터미널 보기 위에 얹힌 화면이다. 여기서 문제가 나도 hook 응답은 나가야 한다.
      try { chat.noteHook(workspace.id, event, payload, event === 'Stop' && out !== ''); } catch { /* 채팅 보기만 영향받는다 */ }
      return out;
    },
  }, [workspaceTools, todoTools, messageTools, artifactTools, commitTools]);
  const service = new WorkspaceService({
    projects, repos, workspaces, pty, todos, messages, git, mcpUrl: mcp.url, hookUrl: mcp.hookUrl, dataDir: o.dataDir, worktreeRoot: o.worktreeRoot, baseEnv: o.baseEnv,
  });

  const delivery: DeliveryService = new DeliveryService({
    workspaces, todos, messages,
    actions: {
      isConfirmedIdle: (id) => service.isConfirmedIdle(id),
      isRemoving: (id) => service.isRemoving(id),
      lastActivityAt: (id) => service.lastActivityAt(id),
      wake: (id, text) => service.wake(id, text),
      // 기다리던 메시지는 startAgent 가 takeForStart 로 가져가 첫 프롬프트로 준다.
      start: async (id) => { await service.startAgent(id, { cols: 120, rows: 40 }); },
    },
  });
  service.attachDelivery(delivery);
  service.attachChat(chat);
  // 채팅 방식의 에이전트: 터미널 화면 없이 구조화된 입출력으로 돈다.
  const engine = new ChatEngine({
    onSession: (id, sessionId) => { if (workspaces.get(id)) workspaces.setSessionId(id, sessionId); },
    onWaiting: (id, waiting) => service.noteWaiting(id, waiting),
    // 차례가 끝났는데도 '작업 중' 이면 Stop hook 이 오지 않은 것이다 (사용자가 멈춤, 로그인 만료 같은 오류). 쉬는 중으로 되돌린다.
    // 보통은 Stop hook 이 먼저 와서 이미 쉬는 중이고, 그때는 아무것도 바뀌지 않는다.
    onTurnEnd: (id) => { chat.interrupted(id); service.noteInterrupted(id); },
    onActivity: (id) => chat.refreshSoon(id, [0, 300, 1200]),
    onExit: (id, code, stderr) => service.noteSessionExit(id, code, stderr),
  });
  service.attachEngine(engine);
  // 전달이 실패하면 메시지는 미전달로 되돌아가고 이유가 delivery.error 에 남아 화면에 보인다. 여기서는 오류를 삼킨다.
  const kick = (workspaceId: string): void => { delivery.kick(workspaceId).catch(() => undefined); };
  const onSent = (m: { toWorkspaceId: string }): void => kick(m.toWorkspaceId);
  const onReleased = (projectId: string): void => { for (const w of workspaces.list(projectId)) kick(w.id); };
  messages.on('sent', onSent);
  messages.on('released', onReleased);

  onStatus = (id) => service.emit('changed', id);
  noteHook = (id, event, blocked) => service.noteHook(id, event, blocked);

  const commit = new CommitService({ workspaces, git, drafts: commitDrafts, messages });

  let disposed = false;
  return {
    projects, repos, workspaces, service, todos, messages, delivery, chat, engine, commitDrafts, commit,
    chatView(workspaceId) {
      const snap = chat.snapshot(workspaceId);
      const ws = workspaces.get(workspaceId);
      const live = engine.has(workspaceId);
      const o = engine.overlay(workspaceId);
      return {
        ...snap,
        // 채팅 방식에서는 승인 요청이 엔진으로 온다 (hook 의 알림이 아니라).
        pendingPermission: live ? o.permission : snap.pendingPermission,
        streaming: o.streaming,
        question: o.question,
        engine: ws?.engine ?? 'terminal',
        lastError: service.exitError(workspaceId) ?? null,
        canSend: service.canSendInput(workspaceId),
      };
    },
    slashCommands: (workspaceId) => engine.commands(workspaceId), pty, git, mcpUrl: mcp.url,
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
      chat.dispose();
      await engine.stopAll();
      await pty.killAll();
      await mcp.close();
      db.close();
    },
  };
}
