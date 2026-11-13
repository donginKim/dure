import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Repo, RepoStatus } from '@shared/types';
import { ChatService } from './chat/chatService';
import { CleanupService } from './cleanup';
import { AssignmentService } from './assignments';
import { setOracleClient } from './dbquery/drivers';
import { CoordinatorService } from './coordinator';
import { coordinatorTools } from './mcp/tools/coordinator';
import { browserTools } from './mcp/tools/browser';
import { BrowserService, noBrowser, type BrowserDriver } from './browserService';
import { dbTools } from './mcp/tools/db';
import { slackTools } from './mcp/tools/slack';
import { SlackService } from './slackService';
import { UpdateService } from './updateService';
import { NoteStore } from './notes';
import { AttentionService } from './attention';
import { UsageStore } from './usage';
import { CheckpointService } from './checkpoints';
import { PrService } from './pr';
import { WorkTimeService, type NetworkProbe } from './worktime';
import { noteTools } from './mcp/tools/notes';
import { PeerService, type PeerDiscovery, type PeerTransport } from './peers/peerService';
import { DbService, noSecrets, type SecretBox } from './dbService';
import { cleanupTools } from './mcp/tools/cleanup';
import { SettingsService } from './settings';
import { ChatEngine } from './chat/engine';
import type { ChatView, CompletionChoice, CompletionPlan, ModelChoice, Project, SlashCommand } from '@shared/types';
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
  settings: SettingsService;
  cleanup: CleanupService;
  coordinator: CoordinatorService;
  dbs: DbService;
  slack: SlackService;
  updates: UpdateService;
  notes: NoteStore;
  attention: AttentionService;
  usage: UsageStore;
  checkpoints: CheckpointService;
  prs: PrService;
  worktime: WorkTimeService;
  browser: BrowserService;
  peers: PeerService;
  assignments: AssignmentService;
  /** 프로젝트를 완료 처리하기 전에 보여줄 것: 워크스페이스의 상태와 정리 대기에 있는 것 */
  completionPlan(projectId: string): Promise<CompletionPlan>;
  /** 프로젝트를 완료 처리한다: 에이전트를 끄고, 고른 작업 폴더와 정리 대기 항목을 지우고, 프로젝트를 완료로 옮긴다. 기록은 남는다 */
  completeProject(projectId: string, choice: CompletionChoice): Promise<Project>;
  /** 완료된 프로젝트를 다시 연다. 지운 작업 폴더는 돌아오지 않는다 */
  reopenProject(projectId: string): Project;
  /** 프로젝트를 기록까지 완전히 지운다. 작업 폴더는 남긴다 */
  removeProject(projectId: string): Promise<void>;
  /** 설정 화면이 고르게 보여줄 모델 목록. 받아 둔 것이 없으면 Claude Code 에게 물어 온다. refresh: 받아 둔 것이 있어도 다시 묻는다 */
  models(refresh?: boolean): Promise<ModelChoice[]>;
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
  /** 다른 사람의 두레와 주고받는 쪽 (앱은 HTTP). 없으면 연결 기능을 켤 수 없다 */
  peerTransport?: PeerTransport;
  /** 같은 네트워크에서 서로 찾는 쪽 (앱은 Bonjour) */
  peerDiscovery?: PeerDiscovery;
  /** 내장 브라우저의 페이지를 움직이는 쪽 (앱은 Electron 메인 프로세스). 없으면 에이전트는 브라우저를 쓸 수 없다 */
  browser?: BrowserDriver;
  /** 시험용: 주소 허용을 기다리는 시간 */
  browserWaitMs?: number;
  /** DB 비밀번호를 암호화해 보관하는 방법 (앱은 macOS 키체인). 없으면 비밀번호가 있는 연결을 저장할 수 없다 */
  secrets?: SecretBox;
  /** 시험용: DB 실행기를 가짜로 바꾸고, 승인을 기다리는 시간을 줄인다 */
  dbRunner?: ConstructorParameters<typeof DbService>[0]['runner'];
  /** 지금 돌고 있는 앱 묶음의 경로 (…/Dure.app). 묶인 앱일 때만 준다: 소스에서 설치한 앱의 업데이트에 쓴다 */
  runningApp?: string | null;
  /** 지금 붙어 있는 네트워크를 알아보는 쪽 (근무시간). 주지 않으면 macOS 의 명령으로 알아본다. null 이면 저절로 재지 않는다 (시험) */
  networkProbe?: (() => Promise<NetworkProbe>) | null;
  /** false 면 업데이트 뒤 앱을 다시 켜지 않는다 (검증용) */
  updateReopen?: boolean;
  /** 시험에서 가짜 슬랙으로 바꾼다 */
  slackFetch?: ConstructorParameters<typeof SlackService>[0]['fetch'];
  dbWaitMs?: number;
  /** 한 사람의 계획 제안을 받는 최소 간격 (ms). 시험에서 줄인다 */
  suggestEveryMs?: number;
  /** 계획안의 새 저장소를 만드는 상위 폴더. 기본은 worktreeRoot 옆의 repos */
  repoRoot?: string;
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
    for (const w of workspaces.listAll(p.id)) {
      if (w.status !== 'stopped') workspaces.update(w.id, { status: 'stopped' });
    }
  }

  const todos = new TodoService(db);
  const settings = new SettingsService(db);
  const messages = new MessageService(db);
  const git = createGit(o.baseEnv);
  const notes = new NoteStore(db);
  const usage = new UsageStore(db, workspaces);
  const checkpoints = new CheckpointService({ db, workspaces, git });
  const prs = new PrService({ db, workspaces, git, env: o.baseEnv });
  const worktime = new WorkTimeService({ db, settings: () => settings.get(), probe: o.networkProbe ?? undefined });
  // 시험에서는 저절로 재지 않는다 (가짜 네트워크를 줄 때만).
  if (o.networkProbe !== null) worktime.start();
  settings.on('changed', () => { void worktime.tick(); });
  const cleanup = new CleanupService({ db, workspaces, git, dir: join(o.dataDir, 'cleanup') });
  messages.useCaps(() => { const s = settings.get(); return { thread: s.threadCap, project: s.projectCap }; });
  const commitDrafts = new CommitDraftStore(db);
  const pty = new PtyManager();
  // hook 으로 상태가 바뀌면 서비스의 'changed' 로 내보낸다. 서비스는 MCP 주소가 정해진 뒤에 만들어지므로 나중에 잇는다.
  let onStatus: (workspaceId: string) => void = () => undefined;
  let noteHook: (workspaceId: string, event: string, blocked: boolean) => void = () => undefined;
  const chat = new ChatService({ workspaces, // Claude Code 는 CLAUDE_CONFIG_DIR 가 있으면 그 폴더에 대화 기록을 둔다. 에이전트가 물려받는 환경과 같은 값을 쓴다.
    allowedRoot: o.claudeDir ?? [o.baseEnv.CLAUDE_CONFIG_DIR ?? '', join(homedir(), '.claude')], onInterrupted: (id) => service.noteInterrupted(id), onUsage: (id, u) => usage.record(id, u) });
  const mcp = await startMcpServer({
    workspaces, projects, repos, todos, messages, commitDrafts, cleanup, git,
    // 조율 서비스는 워크스페이스 서비스가 만들어진 뒤에 생긴다. 요청을 처리할 때 읽으므로 그때는 이미 있다.
    get coordinator() { return coordinator; },
    get dbs() { return dbs; },
    get slack() { return slack; },
    notes,
    notesForAgents: () => settings.get().notesForAgents,
    notesWriteForAgents: () => settings.get().notesWriteForAgents,
    prs,
    get browser() { return browser; },
    get peers() { return peers; },
    get assignments() { return assignments; },
    describe: (workspaceId, patch) => service.describeByAgent(workspaceId, patch),
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
      // 채팅 방식: 승인·질문 대기는 엔진이 안다. hook 이 바꾼 상태를 그에 맞춘다.
      service.reconcileWaiting(workspace.id);
      // 막 띄운 채팅 방식 에이전트가 쉬는 중이 됐다. 그동안 기다리던 메시지를 전달한다.
      if (event === 'SessionStart' && engine.has(workspace.id)) setTimeout(() => kick(workspace.id), 0);
      return out;
    },
  }, [workspaceTools, todoTools, messageTools, artifactTools, commitTools, cleanupTools, coordinatorTools, dbTools, browserTools, slackTools, noteTools]);
  const service = new WorkspaceService({
    projects, repos, workspaces, pty, todos, messages, git, mcpUrl: mcp.url, hookUrl: mcp.hookUrl, dataDir: o.dataDir, worktreeRoot: o.worktreeRoot, settings: () => settings.get(), baseEnv: o.baseEnv,
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
      autoStart: () => settings.get().autoStartOnMessage,
      isProjectClosed: (projectId) => service.isProjectClosed(projectId),
    },
  });
  const coordinator: CoordinatorService = new CoordinatorService({ suggestEveryMs: o.suggestEveryMs, db, projects, repos, workspaces, todos, messages, git, service, dir: join(o.dataDir, 'coordinators'), repoRoot: o.repoRoot ?? join(dirname(o.worktreeRoot), 'repos'), settings: () => settings.get(),
    // 계획안의 일을 함께하는 사람에게 나눠 준다. 아래에서 만들어지는 것들을 부를 때 읽는다.
    assign: {
      // 내가 열었으면 나눠 줄 수 있는 사람들. 참여한 프로젝트면 함께하는 사람 모두 (계획안은 리더에게 제안으로 간다).
      people: (projectId) => (peers.share(projectId)?.mine === false ? peers.people(projectId) : peers.assignable(projectId)),
      team: (projectId) => {
        const s = peers.share(projectId);
        return s ? { mine: s.mine, myId: s.members.find((m) => m.me)?.peerId ?? '', leaderName: s.members.find((m) => m.owner)?.name ?? '프로젝트를 연 사람', auto: s.suggestMode === 'auto' } : null;
      },
      suggest: (projectId, plan) => assignments.suggest(projectId, plan),
      result: (projectId, peerId, sid, state, reason) => assignments.result(projectId, peerId, sid, state, reason),
      send: (projectId, peerId, a, o) => assignments.send(projectId, peerId, a, o), cancel: (id) => assignments.cancel(id), link: (ids, parents) => assignments.link(ids, parents), brief: (projectId, summary, skip) => assignments.sendBrief(projectId, summary, skip) },
  });
  // Oracle 에 접속하는 방식 (설정의 Oracle Instant Client 폴더). 이미 접속한 뒤에 바꾸면 다시 켜야 듣는다.
  setOracleClient(settings.get().oracleClientDir);
  settings.on('changed', () => setOracleClient(settings.get().oracleClientDir));
  const dbs: DbService = new DbService({ db, projects, workspaces, messages, secrets: o.secrets ?? noSecrets, runner: o.dbRunner, waitMs: o.dbWaitMs, isProjectClosed: (projectId) => service.isProjectClosed(projectId) });
  // 워크스페이스가 지워지면 그 에이전트가 기다리던 조회 요청도 끝낸다.
  service.on('changed', (id: string) => { if (!workspaces.get(id)) dbs.dropWorkspace(id); });
  const slack: SlackService = new SlackService({ db, workspaces, messages, secrets: o.secrets ?? noSecrets, fetch: o.slackFetch, waitMs: o.dbWaitMs, isProjectClosed: (projectId) => service.isProjectClosed(projectId) });
  service.on('changed', (id: string) => { if (!workspaces.get(id)) slack.dropWorkspace(id); });
  const updates = new UpdateService({ git, dataDir: o.dataDir, infoPath: join(o.dataDir, 'install.json'), runningApp: o.runningApp ?? null, env: o.baseEnv, reopen: o.updateReopen });
  updates.start();
  const browser = new BrowserService({ driver: o.browser ?? noBrowser, workspaces, messages, waitMs: o.browserWaitMs, settings: () => settings.get(), isProjectClosed: (projectId) => service.isProjectClosed(projectId) });
  service.on('changed', (id: string) => { if (!workspaces.get(id)) browser.dropWorkspace(id); });
  const noTransport: PeerTransport = {
    listen: async () => { throw new Error('이 환경에서는 다른 사람과 연결할 수 없습니다.'); },
    close: async () => undefined,
    request: async () => { throw new Error('이 환경에서는 다른 사람과 연결할 수 없습니다.'); },
  };
  const peers = new PeerService({
    db, projects, workspaces, messages, settings: () => settings.get(), secrets: o.secrets ?? noSecrets,
    transport: o.peerTransport ?? noTransport, discovery: o.peerDiscovery, isProjectClosed: (projectId) => service.isProjectClosed(projectId),
  });
  const assignments = new AssignmentService({ db, peers, projects, repos, workspaces, todos, messages, service, coordinator: () => coordinator });
  // 워크스페이스의 이름이 바뀌거나 지워지면 공개한 목록을 다시 보낸다. 설정이 바뀌면 듣기를 켜거나 끈다.
  service.on('changed', () => peers.publishSoon());
  settings.on('changed', () => { void peers.apply(); });
  await peers.apply();
  service.attachDelivery(delivery);
  service.attachChat(chat);
  // 채팅 방식의 에이전트: 터미널 화면 없이 구조화된 입출력으로 돈다.
  const engine = new ChatEngine({
    onSession: (id, sessionId) => { if (workspaces.get(id)) workspaces.setSessionId(id, sessionId); },
    onWaiting: (id, waiting) => service.noteWaiting(id, waiting),
    // 차례가 끝났는데도 '작업 중' 이면 Stop hook 이 오지 않은 것이다 (사용자가 멈춤, 로그인 만료 같은 오류). 쉬는 중으로 되돌린다.
    // 보통은 Stop hook 이 먼저 와서 이미 쉬는 중이고, 그때는 아무것도 바뀌지 않는다.
    onTurnEnd: (id) => {
      chat.interrupted(id);
      service.noteTurnEnd(id);
      // 쉬게 됐으니 기다리던 메시지가 있으면 지금 전달한다 (채팅 방식은 쉬는 중이면 바로 받을 수 있다).
      kick(id);
    },
    onActivity: (id) => chat.refreshSoon(id, [0, 300, 1200]),
    onExit: (id, code, stderr) => service.noteSessionExit(id, code, stderr),
  });
  service.attachEngine(engine);
  // 받아 둔 모델 목록은 저장해 두고, 다음에 켰을 때 곧바로 보인다.
  engine.seedModels(settings.savedModels());
  engine.on('models', (models: ModelChoice[]) => { try { settings.saveModels(models); } catch { /* 닫는 중 */ } });
  // 전달이 실패하면 메시지는 미전달로 되돌아가고 이유가 delivery.error 에 남아 화면에 보인다. 여기서는 오류를 삼킨다.
  const kick = (workspaceId: string): void => { delivery.kick(workspaceId).catch(() => undefined); };
  const onSent = (m: { toWorkspaceId: string }): void => kick(m.toWorkspaceId);
  const onReleased = (projectId: string): void => { for (const w of workspaces.listAll(projectId)) kick(w.id); };
  messages.on('sent', onSent);
  messages.on('released', onReleased);

  onStatus = (id) => service.emit('changed', id);
  noteHook = (id, event, blocked) => service.noteHook(id, event, blocked);

  // 확인할 것: 흩어진 요청을 한 목록으로. 다른 서비스가 바뀔 때마다 다시 본다.
  const attention = new AttentionService({
    projects: () => projects.list(), isClosed: (id) => service.isProjectClosed(id), workspaces: (id) => workspaces.listAll(id),
    plan: (id) => coordinator.pending(id), db: (id) => dbs.pending(id), slack: (id) => slack.pending(id), browser: (id) => browser.pending(id),
    held: (id) => peers.held(id), assignments: (id) => assignments.incoming(id), briefs: (id) => assignments.briefs(id), pairs: () => peers.requests(), invites: () => peers.shareInvites(),
  });
  for (const src of [service, coordinator, dbs, slack, browser, peers, assignments]) src.on('changed', () => attention.poke());
  attention.poke();

  const commit = new CommitService({ workspaces, git, drafts: commitDrafts, messages, notifyAgent: () => settings.get().notifyAgentOnCommit });

  let disposed = false;
  return {
    projects, repos, workspaces, service, todos, messages, delivery, chat, engine, settings, cleanup, coordinator, dbs, slack, updates, notes, attention, usage, checkpoints, prs, worktime, browser, peers, assignments, commitDrafts, commit,
    async completionPlan(projectId) {
      if (!projects.get(projectId)) throw new Error(`프로젝트가 없습니다: ${projectId}`);
      const list = await Promise.all(workspaces.list(projectId).map(async (w) => {
        const exists = existsSync(w.worktreePath);
        return {
          id: w.id, name: w.name, branch: w.branch, worktreePath: w.worktreePath, exists,
          // 확인하지 못한 것을 0 으로 치지 않는다: "변경 없음" 으로 보여 지워도 되는 것처럼 보이면 안 된다.
          uncommitted: exists ? await git.uncommittedCount(w.worktreePath).catch(() => null) : 0,
          ignored: exists ? await git.ignoredCount(w.worktreePath).catch(() => null) : 0,
          unpushed: exists ? await git.aheadCount(w.worktreePath, w.branch).catch(() => null) : null,
          agentRunning: service.isAgentRunning(w.id),
        };
      }));
      return { workspaces: list, items: cleanup.list(projectId) };
    },
    async completeProject(projectId, choice) {
      const project = projects.get(projectId);
      if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
      if (project.status === 'done') return project;
      const all = workspaces.list(projectId);
      // 조율 에이전트도 끈다 (작업 폴더가 없어 지울 것은 없다).
      const everyone = workspaces.listAll(projectId);
      const removeWorktrees = new Set(Array.isArray(choice?.removeWorktrees) ? choice.removeWorktrees : []);
      const removeItems = new Set(Array.isArray(choice?.removeItems) ? choice.removeItems : []);
      const seen = typeof choice?.seen === 'object' && choice.seen !== null ? choice.seen : {};
      // 이 프로젝트의 것이 아닌 id 는 받지 않는다.
      const items = cleanup.list(projectId).filter((i) => removeItems.has(i.id));
      // 끄고 지우는 사이에 에이전트가 다시 뜨지 않게 먼저 막는다 (메시지로 띄우기, 사용자의 시작 버튼).
      service.setCompleting(projectId, true);
      try {
        // 에이전트를 모두 끈다: 지우는 폴더에서 돌고 있으면 안 되고, 완료된 프로젝트에서는 일하지 않는다.
        for (const w of everyone) await service.stopAndWait(w.id);
        const alive = everyone.filter((w) => service.isAgentRunning(w.id) || pty.list(w.id).length > 0);
        if (alive.length) throw new Error(`에이전트나 터미널이 꺼지지 않았습니다: ${alive.map((w) => w.name).join(', ')}. 잠시 뒤 다시 하세요.`);
        // 지우기 전에 다시 센다. 목록을 본 뒤에 생긴 변경이 있으면 아무것도 지우지 않는다.
        const targets = all.filter((w) => removeWorktrees.has(w.id) && existsSync(w.worktreePath));
        const changed: string[] = [];
        for (const w of targets) {
          const now = await git.uncommittedCount(w.worktreePath).catch(() => null);
          const before = Object.prototype.hasOwnProperty.call(seen, w.id) ? seen[w.id] : undefined;
          if (before === undefined || now !== before) changed.push(w.name);
        }
        if (changed.length) throw new Error(`목록을 본 뒤에 작업 폴더가 바뀌었습니다: ${changed.join(', ')}. 아무것도 지우지 않았습니다. 다시 확인하세요.`);
        const failed: string[] = [];
        for (const w of targets) {
          const repo = repos.get(w.repoId);
          try {
            if (!repo) throw new Error('저장소 정보가 없습니다');
            await git.removeWorktree({ repoPath: repo.path, worktreePath: w.worktreePath });
          } catch (e) { failed.push(`${w.name}: ${e instanceof Error ? e.message : String(e)}`); }
        }
        // 지우지 못한 작업 폴더가 있으면 거기서 멈춘다: 정리 대기는 그대로 두고 완료로 넘기지 않는다.
        if (failed.length) throw new Error(`작업 폴더를 지우지 못했습니다. ${failed.join(' / ')}`);
        cleanup.remove(items.map((i) => i.id));
        const done = projects.setStatus(projectId, 'done');
        return done;
      } finally {
        service.setCompleting(projectId, false);
        service.emit('changed', projectId);
      }
    },
    reopenProject(projectId) {
      if (!projects.get(projectId)) throw new Error(`프로젝트가 없습니다: ${projectId}`);
      const p = projects.setStatus(projectId, 'active');
      service.emit('changed', projectId);
      return p;
    },
    async removeProject(projectId) {
      // 워크스페이스는 터미널과 에이전트만 끄고 작업 폴더는 남긴다. 정리 대기에 옮겨 둔 것은 함께 지운다.
      for (const ws of workspaces.listAll(projectId)) await service.remove(ws.id, { deleteWorktree: false, withCoordinator: true });
      cleanup.removeProject(projectId);
      // 조율 에이전트의 폴더는 두레의 것이다. 함께 지운다.
      const coordDir = join(o.dataDir, 'coordinators', projectId);
      if (coordDir.startsWith(join(o.dataDir, 'coordinators') + sep)) rmSync(coordDir, { recursive: true, force: true });
      projects.remove(projectId);
    },
    models: async (refresh) => (engine.models().length > 0 && !refresh ? engine.models() : service.loadModels()),
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
      const added = repos.add(projectId, path);
      // 조율 에이전트가 새로 등록한 저장소를 읽을 수 있게 한다 (쉬는 중일 때만 다시 띄운다).
      void coordinator.reload(projectId).catch(() => undefined);
      return added;
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
      updates.dispose();
      worktime.dispose();
      attention.dispose();
      chat.dispose();
      await engine.stopAll();
      assignments.dispose();
      await peers.dispose();
      await pty.killAll();
      await mcp.close();
      db.close();
    },
  };
}
