import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Repo, RepoStatus, Todo, Agreement, ProjectDashboard, WorkReport, UsageBar, AwayChoice, NewsPanel, AgentConfig } from '@shared/types';
import { ChatService } from './chat/chatService';
import { CleanupService } from './cleanup';
import { AssignmentService } from './assignments';
import { ReviewService, type ReviewRunner } from './review';
import { MakeService, type MakeRunner } from './makes';
import { readAgentConfig } from './agentConfig';
import { riskyChoice } from './away';
import { cleanViewPref, type ProjectViewPref } from '@shared/roles';
import { MergeService } from './merge';
import { AutoShipService } from './autoship';
import { BudgetService } from './budget';
import { ActivityService } from './activity';
import { shellRunner, VerifyService, type VerifyRunner } from './verify';
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
import { DoingService } from './doing';
import { PaddyService, dayOf } from './paddy';
import { DigestService } from './digest';
import { ScheduleService } from './schedule';
import { CaptureStore } from './captures';
import { PluginService } from './plugins';
import { FeedReader } from './feeds';
import { UsageStore } from './usage';
import { CheckpointService } from './checkpoints';
import { PrService } from './pr';
import { WorkTimeService, type NetworkProbe } from './worktime';
import { noteTools } from './mcp/tools/notes';
import { agreementTools } from './mcp/tools/agreements';
import { memoryTools } from './mcp/tools/memory';
import { MemoryStore } from './memory';
import { figureTools } from './mcp/tools/figures';
import { FigureService } from './figures';
import { AgreementService } from './agreements';
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
  verify: VerifyService;
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
  /** 처음 켤 때 안내: Claude Code 와 git 이 있는가, Claude Code 에 로그인했는가 (알 수 없으면 null) */
  doctor(): Promise<{ claude: string | null; git: string | null; loggedIn: boolean | null }>;
  /** 채팅 화면이 받는 것: 대화, 쓰는 중인 글, 승인·질문 대기 */
  chatView(workspaceId: string): ChatView;
  slashCommands(workspaceId: string): SlashCommand[];
  commitDrafts: CommitDraftStore;
  commit: CommitService;
  review: ReviewService;
  merges: MergeService;
  agreements: AgreementService;
  figures: FigureService;
  autoShip: AutoShipService;
  budget: BudgetService;
  activity: ActivityService;
  /** 워크스페이스마다 지금 하는 일 (마지막 도구 사용) */
  doing: DoingService;
  /** 두레 논 (날마다 한 일) */
  paddy: PaddyService;
  /** 하루 결산 */
  digest: DigestService;
  /** 예약 실행 */
  schedules: ScheduleService;
  /** 빠른 메모 */
  captures: CaptureStore;
  /** 프로젝트 기억 */
  memory: MemoryStore;
  /** 설치형 플러그인 */
  plugins: PluginService;
  /** 만들기: 프로젝트의 자료로 보고서·발표 자료·그림을 만든다 */
  makes: MakeService;
  /** 소식 화면: 승인한 플러그인의 소식판을 읽어 온다 (force 면 받아 둔 것을 쓰지 않는다) */
  news(force?: boolean): Promise<NewsPanel[]>;
  /** 소식 화면에 보인 적이 있는 링크인가 (그런 것만 바깥 브라우저로 연다) */
  knownNewsLink(url: string): boolean;
  /** 하단바: 오늘 쓴 토큰과 사용 한도 */
  usageBar(): UsageBar;
  /** 자리 비움 동안 두레가 대신 고른 답 (새것부터) */
  /** 프로젝트의 보기 설정 (내 역할, 역할별 칸 구성) */
  projectView(projectId: string): ProjectViewPref;
  setProjectView(projectId: string, role: unknown, custom: unknown): ProjectViewPref;
  /** 작업 폴더의 에이전트 설정 파일과 허용 여부 */
  agentConfig(workspaceId: string): AgentConfig;
  /** 화면에서 본 내용(hash)을 허용한다. 그사이 바뀌었으면 거절한다 */
  trustAgentConfig(workspaceId: string, hash: string): void;
  awayChoices(): AwayChoice[];
  /** 대신 고른 답의 기록을 지운다 (id 를 비우면 전부) */
  clearAwayChoices(id?: string): void;
  /** 여러 프로젝트 대시보드: 진행 중인 프로젝트마다 한눈 요약 */
  dashboard(): ProjectDashboard[];
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
  /** 소식 피드를 읽는 것 (시험에서 바꿔 끼운다) */
  feedReader?: FeedReader;
  /** false 면 업데이트 뒤 앱을 다시 켜지 않는다 (검증용) */
  updateReopen?: boolean;
  /** 시험에서 가짜 슬랙으로 바꾼다 */
  slackFetch?: ConstructorParameters<typeof SlackService>[0]['fetch'];
  dbWaitMs?: number;
  /** 일하는 중에 이만큼 움직임이 없으면 막힌 것으로 본다 (ms). 시험에서 줄인다 */
  stuckQuietMs?: number;
  /** 리뷰 에이전트를 돌리는 쪽 (시험에서 바꾼다) */
  reviewRunner?: ReviewRunner;
  makeRunner?: MakeRunner;
  /** 확인 명령을 돌리는 쪽 (시험에서 바꾼다) */
  verifyRunner?: VerifyRunner;
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
  // 예산: 하루·전체 상한을 넘으면 그 프로젝트의 에이전트를 멈추고 새로 일을 시키지 않는다.
  const budget = new BudgetService(db, projects, Date.now, () => settings.get().defaultBudgetDaily);
  const checkpoints = new CheckpointService({ db, workspaces, git });
  const prs = new PrService({ db, workspaces, git, env: o.baseEnv });
  // 일의 순서: 앞의 일이 다 끝난 항목이 생기면 그 워크스페이스에 알린다 (꺼져 있으면 이 알림으로 뜬다).
  todos.on('unblocked', (todo: Todo, done: Todo) => {
    if (!todo.workspaceId || todo.assignee !== 'agent' || service.isProjectClosed(todo.projectId)) return;
    const from = done.workspaceId && done.workspaceId !== todo.workspaceId ? workspaces.get(done.workspaceId)?.name : undefined;
    try {
      messages.send({
        projectId: todo.projectId, from: { kind: 'system' }, toWorkspaceId: todo.workspaceId, title: '순서',
        body: `앞의 일이 끝났다${from ? ` (워크스페이스 "${from}")` : ''}: "${done.title}". 이제 "${todo.title}" 을(를) 시작할 수 있다. todo_list 로 확인하고 진행하라.${from ? ' 그 일의 결과(API 형식 등)가 필요하면 그 워크스페이스가 올린 자료를 읽거나 message_send 로 물어라.' : ''}`,
      });
    } catch { /* 알림 실패가 상태 변경을 막으면 안 된다 */ }
  });
  // 끝난 일의 확인: 에이전트가 TODO 를 완료로 바꿀 때 저장소의 확인 명령을 돌린다.
  // 프로젝트의 약속: 에이전트는 읽고 제안만 한다. 사용자가 받아들이면 모든 에이전트에게 알린다.
  const agreements = new AgreementService(db);
  // 에이전트가 그린 그림 (워크스페이스 옆 패널의 "그림" 탭)
  const figures = new FigureService(db);
  const verify = new VerifyService({ db, repos, workspaces, git, env: o.baseEnv, timeoutMs: () => settings.get().verifyTimeoutSec * 1000, runner: o.verifyRunner });
  const worktime = new WorkTimeService({ db, settings: () => settings.get(), probe: o.networkProbe ?? undefined });
  // 시험에서는 저절로 재지 않는다 (가짜 네트워크를 줄 때만).
  if (o.networkProbe !== null) worktime.start();
  settings.on('changed', () => { void worktime.tick(); });
  const cleanup = new CleanupService({ db, workspaces, git, dir: join(o.dataDir, 'cleanup') });
  const memory = new MemoryStore(db);
  messages.useCaps(() => { const s = settings.get(); return { thread: s.threadCap, project: s.projectCap }; });
  const commitDrafts = new CommitDraftStore(db);
  const pty = new PtyManager();
  // hook 으로 상태가 바뀌면 서비스의 'changed' 로 내보낸다. 서비스는 MCP 주소가 정해진 뒤에 만들어지므로 나중에 잇는다.
  let onStatus: (workspaceId: string) => void = () => undefined;
  let noteHook: (workspaceId: string, event: string, blocked: boolean) => void = () => undefined;
  const chat = new ChatService({ workspaces, // Claude Code 는 CLAUDE_CONFIG_DIR 가 있으면 그 폴더에 대화 기록을 둔다. 에이전트가 물려받는 환경과 같은 값을 쓴다.
    allowedRoot: o.claudeDir ?? [o.baseEnv.CLAUDE_CONFIG_DIR ?? '', join(homedir(), '.claude')], onInterrupted: (id) => service.noteInterrupted(id), onUsage: (id, u) => { usage.record(id, u); const w = workspaces.get(id); if (w) budget.check(w.projectId); } });
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
    verify,
    agreements,
    figures,
    memory,
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
          // hook 만으로는 믿지 않는다 (에이전트도 hook 주소를 부를 수 있다): 사용자가 방금 그 터미널에 입력했을 때만 센다.
          // 채팅 방식의 입력은 보낼 때 따로 센다 (sendUserInput).
          if (!service.consumeSynthetic(w.id) && service.userTypedRecently(w.id)) messages.userIntervened(w.projectId);
        },
      }, workspace, event, payload);
      // 승인 요청이 아닌 알림(입력을 기다린다는 알림 등)은 에이전트가 일을 시작했다는 뜻이 아니다.
      // 그런 알림 때문에 '쉬는 중 확인' 을 지우면 쉬는 에이전트에게 메시지를 전달하지 못한다.
      if (event === 'Notification' && isPermissionPrompt(payload) && workspace.engine !== 'chat') service.notePermissionPrompt(workspace.id);
      if (event !== 'Notification' || isPermissionPrompt(payload)) noteHook(workspace.id, event, out !== '');
      // 채팅 보기는 터미널 보기 위에 얹힌 화면이다. 여기서 문제가 나도 hook 응답은 나가야 한다.
      try { chat.noteHook(workspace.id, event, payload, event === 'Stop' && out !== ''); } catch { /* 채팅 보기만 영향받는다 */ }
      try { doing.note(workspace.id, event, payload); } catch { /* 보기만 영향받는다 */ }
      // 채팅 방식: 승인·질문 대기는 엔진이 안다. hook 이 바꾼 상태를 그에 맞춘다.
      service.reconcileWaiting(workspace.id);
      // 막 띄운 채팅 방식 에이전트가 쉬는 중이 됐다. 그동안 기다리던 메시지를 전달한다.
      if (event === 'SessionStart' && engine.has(workspace.id)) setTimeout(() => kick(workspace.id), 0);
      // TODO 를 끝내고 쉬는 에이전트는 다음 TODO 를 새 대화로 시작한다 (설정에서 끌 수 있다).
      if (event === 'Stop' && out === '') service.maybeFresh(workspace.id);
      return out;
    },
  }, [workspaceTools, todoTools, messageTools, artifactTools, commitTools, cleanupTools, coordinatorTools, dbTools, browserTools, slackTools, noteTools, agreementTools, figureTools, memoryTools]);
  const service = new WorkspaceService({
    agentConfigTrusted: (repoId, hash) => db.prepare('SELECT 1 FROM agent_config_trust WHERE repo_id = ? AND hash = ?').get(repoId, hash) !== undefined,
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
      reportSelf: (projectId, body, ids) => assignments.reportSelf(projectId, body, ids),
      result: (projectId, peerId, sid, state, reason) => assignments.result(projectId, peerId, sid, state, reason),
      send: (projectId, peerId, a, o) => assignments.send(projectId, peerId, a, o), cancel: (id) => assignments.cancel(id), link: (ids, parents) => assignments.link(ids, parents), brief: (projectId, summary, skip) => assignments.sendBrief(projectId, summary, skip) },
  });
  // Oracle 에 접속하는 방식 (설정의 Oracle Instant Client 폴더). 이미 접속한 뒤에 바꾸면 다시 켜야 듣는다.
  setOracleClient(settings.get().oracleClientDir);
  settings.on('changed', () => setOracleClient(settings.get().oracleClientDir));
  // 다른 사람에게 공개된 워크스페이스인가 (공개 범위가 정해져 있다)
  const exposed = (workspaceId: string): boolean => db.prepare('SELECT 1 FROM workspace_sharing WHERE workspace_id = ?').get(workspaceId) !== undefined;
  const dbs: DbService = new DbService({ db, exposed, projects, workspaces, messages, secrets: o.secrets ?? noSecrets, runner: o.dbRunner, waitMs: o.dbWaitMs, isProjectClosed: (projectId) => service.isProjectClosed(projectId) });
  // 워크스페이스가 지워지면 그 에이전트가 기다리던 조회 요청도 끝낸다.
  service.on('changed', (id: string) => { if (!workspaces.get(id)) dbs.dropWorkspace(id); });
  const slack: SlackService = new SlackService({ db, exposed, workspaces, messages, secrets: o.secrets ?? noSecrets, fetch: o.slackFetch, waitMs: o.dbWaitMs, isProjectClosed: (projectId) => service.isProjectClosed(projectId) });
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
  const assignments = new AssignmentService({
    db, peers, projects, repos, workspaces, todos, messages, service, coordinator: () => coordinator,
    reportOn: () => settings.get().shareWorkReport,
    report: (id) => workReport(id),
    askByDefault: () => settings.get().defaultPermissionMode === 'ask',
  });
  // 워크스페이스의 이름이 바뀌거나 지워지면 공개한 목록을 다시 보낸다. 설정이 바뀌면 듣기를 켜거나 끈다.
  service.on('changed', () => peers.publishSoon());
  settings.on('changed', () => { void peers.apply(); });
  await peers.apply();
  service.attachDelivery(delivery);
  service.attachMemory((projectId) => memory.digest(projectId));
  const plugins = new PluginService({ db, dir: join(o.dataDir, 'plugins'),
    // 남의 저장소를 받는다: 끝없이 기다리지 않고, 비밀번호를 묻는 창에서 멈추지 않고, 큰 파일(LFS)은 받지 않는다.
    git: (args) => git.rawWith(args, { timeoutMs: 90_000, extraEnv: { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=15' } }), addMemory: (projectId, kind, text, author) => { memory.add(projectId, { kind, text, author }); } });
  // 만들기의 자료: 두레가 이미 가진 것만 간추린다 (할 일, 기억, 작업 보고). 코드는 담지 않는다.
  const makeMaterials = async (projectId: string): Promise<string> => {
    const LABEL: Record<string, string> = { done: '완료', doing: '하는 중', todo: '남음', cancelled: '취소' };
    const wss = workspaces.list(projectId).filter((w) => w.role !== 'coordinator');
    const nameOf = new Map(wss.map((w) => [w.id, w.name]));
    const all = todos.listProject(projectId);
    const count = (st: string): number => all.filter((t) => t.status === st).length;
    const parts: string[] = [];
    if (all.length) {
      parts.push(`[할 일] 완료 ${count('done')} · 하는 중 ${count('doing')} · 남음 ${count('todo')}${count('cancelled') ? ` · 취소 ${count('cancelled')}` : ''}\n${all.slice(0, 80).map((t) => `- (${LABEL[t.status] ?? t.status}) ${t.title}${t.workspaceId ? ` — ${nameOf.get(t.workspaceId) ?? '워크스페이스'}` : ''}`).join('\n')}`);
    }
    const mem = memory.digest(projectId, 2500);
    if (mem) parts.push(`[기억: 정한 것, 배운 것]\n${mem}`);
    const day = (at: number): string => new Date(at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
    for (const w of wss.slice(0, 8)) {
      const r = await workReport(w.id).catch(() => null);
      const lines = [`[워크스페이스 "${w.name}"]${w.summary ? ` ${w.summary}` : ''}`];
      if (r) {
        if (r.commits.length) lines.push(`커밋 ${r.commits.length}개 (파일 ${r.files.length}개):\n${r.commits.slice(0, 8).map((c) => `- ${day(c.at)} ${c.subject}`).join('\n')}`);
        if (r.verify) lines.push(`확인 명령: ${r.verify.passed ? '통과' : '실패'} (${day(r.verify.at)})`);
        if (r.review) lines.push(`리뷰: 지적 ${r.review.total}건 (높음 ${r.review.high}건)`);
      }
      if (lines.length > 1 || w.summary) parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  };
  mkdirSync(join(o.dataDir, 'makes'), { recursive: true });
  const makes = new MakeService({
    db, env: o.baseEnv, runner: o.makeRunner, cwd: join(o.dataDir, 'makes'),
    executable: () => service.claudeExecutable(), model: () => settings.get().claudeModel,
    projectName: (id) => projects.get(id)?.name ?? null,
    materials: makeMaterials,
    pluginKinds: (id) => plugins.makers(id),
    blocked: (id) => budget.blocked(id),
    onUsage: (projectId, u) => { usage.recordProject(projectId, '만들기', { messageId: `make:${crypto.randomUUID()}`, model: u.model, input: u.input, output: u.output, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead, at: Date.now() }); budget.check(projectId); },
  });
  service.attachPlugins({ instructions: (projectId) => { try { return plugins.instructionsFor(projectId); } catch { return ''; } }, mcp: (projectId) => { try { return plugins.mcpFor(projectId); } catch { return {}; } } });
  service.attachChat(chat);
  // 채팅 방식의 에이전트: 터미널 화면 없이 구조화된 입출력으로 돈다.
  const engine = new ChatEngine({
    onSession: (id, sessionId) => { if (workspaces.get(id)) workspaces.setSessionId(id, sessionId); },
    onWaiting: (id, waiting) => {
      service.noteWaiting(id, waiting);
      // 자리 비움: 선택지 질문이면 추천(첫째) 답을 대신 고른다. 승인 요청(명령 실행 등)은 대신 허용하지 않는다.
      if (waiting && settings.get().awayMode) setTimeout(() => { try { awayAnswer(id); } catch { /* 답하지 못하면 기다리는 채로 둔다 */ } }, 300).unref?.();
    },
    // 차례가 끝났는데도 '작업 중' 이면 Stop hook 이 오지 않은 것이다 (사용자가 멈춤, 로그인 만료 같은 오류). 쉬는 중으로 되돌린다.
    // 보통은 Stop hook 이 먼저 와서 이미 쉬는 중이고, 그때는 아무것도 바뀌지 않는다.
    onTurnEnd: (id) => {
      chat.interrupted(id);
      service.noteTurnEnd(id);
      // 쉬게 됐으니 기다리던 메시지가 있으면 지금 전달한다 (채팅 방식은 쉬는 중이면 바로 받을 수 있다).
      kick(id);
    },
    onActivity: (id) => { chat.refreshSoon(id, [0, 300, 1200]); service.noteActivity(id); },
    onToolResult: (id, error, text) => service.noteToolResult(id, error, text),
    onExit: (id, code, stderr) => service.noteSessionExit(id, code, stderr),
    onLimit: (id, info) => service.noteLimit(id, info),
    onTurnOk: (id) => service.noteTurnOk(id),
  });
  service.attachEngine(engine);
  service.attachBudget((projectId) => budget.blocked(projectId));
  // 막 넘었으면 일하던 에이전트를 멈춘다 (프로세스는 끄지 않는다: 상한을 올리면 이어서 시킬 수 있다).
  budget.on('over', (projectId: string) => {
    for (const w of workspaces.listAll(projectId)) if (w.status === 'working' || w.status === 'waiting_user') { try { service.interrupt(w.id); } catch { /* 이미 멈춤 */ } }
  });
  // 막힘 알아채기: 일하는 중인데 이만큼 움직임이 없으면 확인할 것에 올린다.
  service.watchQuiet(o.stuckQuietMs ?? 10 * 60_000, Math.min(60_000, o.stuckQuietMs ?? 60_000));
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
  const doing = new DoingService();
  // 에이전트가 멈추거나 쉬면 '지금 하는 일' 을 지운다.
  service.on('changed', () => { for (const id of Object.keys(doing.all())) { const st = workspaces.get(id)?.status; if (st !== 'working' && st !== 'waiting_user') doing.clear(id); } });
  const attention = new AttentionService({
    projects: () => projects.list(), isClosed: (id) => service.isProjectClosed(id), workspaces: (id) => workspaces.listAll(id),
    plan: (id) => coordinator.pending(id), db: (id) => dbs.pending(id), slack: (id) => slack.pending(id), browser: (id) => browser.pending(id),
    held: (id) => peers.held(id), assignments: (id) => assignments.incoming(id), briefs: (id) => assignments.briefs(id), pairs: () => peers.requests(), invites: () => peers.shareInvites(),
    limited: (id) => service.limited(id),
    stuck: (id) => service.stuckIn(id),
    agreements: (id) => agreements.list(id, { proposed: true }).filter((a) => a.status === 'proposed'),
    ships: (id) => autoShip.failures(id),
    budget: (id) => budget.alerts(id),
  });
  for (const src of [service, coordinator, dbs, slack, browser, peers, assignments, agreements]) src.on('changed', () => attention.poke());
  attention.poke();

  const paddy = new PaddyService(db);
  const commit = new CommitService({
    onCommitted: (projectId, workspaceId, hash) => {
      // 두레가 만든 커밋을 적어 둔다 (자동 반영이 "검사를 거친 커밋" 과 에이전트가 직접 한 커밋을 가린다).
      if (/^[0-9a-f]{7,40}$/.test(hash)) db.prepare('INSERT OR IGNORE INTO dure_commits (hash, workspace_id, at) VALUES (?, ?, ?)').run(hash, workspaceId, Date.now());
      paddy.note('commit', projectId, workspaceId);
    }, workspaces, git, drafts: commitDrafts, messages, notifyAgent: () => settings.get().notifyAgentOnCommit });
  // 리뷰 에이전트: 커밋 초안이 올라오면 다른 에이전트가 변경을 읽고 문제를 찾는다.
  const review = new ReviewService({
    db, workspaces, git, env: o.baseEnv, runner: o.reviewRunner,
    onUsage: (id, u) => { usage.record(id, { messageId: `review:${crypto.randomUUID()}`, model: u.model, input: u.input, output: u.output, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead, at: Date.now() }); const w = workspaces.get(id); if (w) budget.check(w.projectId); },
    blocked: (projectId) => budget.blocked(projectId),
    changes: async (id) => {
      const st = await commit.state(id);
      return Promise.all(st.files.map(async (f) => { const d = await commit.diff(id, f.path).catch(() => ({ text: '', binary: false, truncated: false })); return { path: f.path, status: f.status, ...d }; }));
    },
    executable: () => service.claudeExecutable(),
    model: () => settings.get().reviewModel || settings.get().claudeModel,
  });
  // 합치기 도우미: 워크스페이스 브랜치들을 차례로 합쳐 보고, 합치기 브랜치를 만들어 확인한 뒤, 사용자가 누르면 기준 브랜치를 옮긴다.
  const merges = new MergeService({
    onAdvanced: (projectId) => paddy.note('main', projectId, null),
    db,
    repos, workspaces, git, messages, todos: (id) => todos.listProject(id), worktreeRoot: o.worktreeRoot, env: o.baseEnv,
    run: o.verifyRunner ?? shellRunner, timeoutMs: () => settings.get().verifyTimeoutSec * 1000, isProjectClosed: (id) => service.isProjectClosed(id),
  });
  // 약속이 정해지거나 바뀌면 그 프로젝트의 모든 에이전트에게 알린다 (꺼져 있으면 다음에 켤 때 받는다).
  agreements.on('settled', (a: Agreement, before?: Agreement) => {
    if (service.isProjectClosed(a.projectId)) return;
    const body = [
      before ? `[두레] 프로젝트의 약속이 바뀌었다: "${a.title}". 앞으로는 이것을 따르라 (앞의 내용과 다르게 만든 것이 있으면 맞춰라).` : `[두레] 프로젝트에 약속이 생겼다: "${a.title}". 모든 워크스페이스가 이것을 따른다.`,
      '', a.body,
      '', `(정한 사람: ${a.author === '사용자' ? '사용자' : `${a.author} 이(가) 제안하고 사용자가 받아들였다`}. 약속 전체는 agreements_list 로 읽는다.)`,
    ].join('\n');
    for (const w of workspaces.listAll(a.projectId)) {
      try { messages.send({ projectId: a.projectId, from: { kind: 'system' }, toWorkspaceId: w.id, title: '약속', body }); } catch { /* 알림 실패가 약속을 되돌리지 않는다 */ }
    }
  });
  // 자동 반영: 확인 명령, 리뷰, 비밀 값을 거쳐 커밋하고, 설정이면 기준 브랜치까지 옮긴다.
  const autoShip = new AutoShipService({ db, knownCommit: (hash) => db.prepare("SELECT 1 FROM dure_commits WHERE ? LIKE hash || '%'").get(hash) !== undefined, projects, repos, workspaces, drafts: commitDrafts, messages, commit, verify, review, merges, git, isProjectClosed: (id) => service.isProjectClosed(id) });
  autoShip.on('changed', () => attention.poke());
  const activity = new ActivityService({ workspaces, messages, todos, git, chat, verify, review, autoShip, figures });
  budget.on('changed', () => attention.poke());
  const reviewTimers = new Map<string, NodeJS.Timeout>();
  commitDrafts.on('changed', (id: string) => {
    const ws = workspaces.get(id);
    if (!commitDrafts.get(id) || !ws || service.isProjectClosed(ws.projectId)) return;
    if (!settings.get().reviewOnDraft && projects.get(ws.projectId)?.autoShip === 'off') return;
    // 초안을 잇달아 고치면 마지막 것만 리뷰한다.
    clearTimeout(reviewTimers.get(id));
    // 자동 반영이 켜진 프로젝트면 그쪽이 리뷰까지 차례로 한다.
    const t = setTimeout(() => { reviewTimers.delete(id); if (projects.get(ws.projectId)?.autoShip !== 'off') void autoShip.run(id); else review.auto(id); }, 3000);
    t.unref?.();
    reviewTimers.set(id, t);
  });

  /** 작업 보고: 기준 브랜치에서 갈라진 뒤의 커밋과 바꾼 파일 이름, 마지막 확인 명령과 리뷰. 코드는 담지 않는다. */
  async function workReport(workspaceId: string): Promise<WorkReport | null> {
    const ws = workspaces.get(workspaceId);
    if (!ws || !existsSync(ws.worktreePath)) return null;
    const commits: WorkReport['commits'] = [];
    const files = new Set<string>();
    try {
      const log = await git.raw(['-C', ws.worktreePath, 'log', '--no-merges', '--max-count=20', '--format=%x1e%H%x1f%ct%x1f%s', '--name-only', `${ws.baseBranch}..HEAD`]);
      for (const rec of log.split('\x1e').filter((x) => x.trim())) {
        const [head, ...lines] = rec.split('\n');
        const [hash, ct, subject] = (head ?? '').split('\x1f');
        const names = lines.map((l) => l.trim()).filter(Boolean);
        for (const n of names) files.add(n);
        commits.push({ hash: (hash ?? '').slice(0, 12), subject: subject ?? '', at: Number(ct) * 1000, files: names.length });
      }
    } catch { /* 기준 브랜치가 없다 등 */ }
    const v = verify.status(workspaceId);
    const r = await review.status(workspaceId).catch(() => null);
    return {
      commits, files: [...files].slice(0, 40),
      verify: v && v.at && (v.state === 'passed' || v.state === 'failed') ? { passed: v.state === 'passed', command: v.command, at: v.at } : null,
      review: r && r.state === 'done' ? { high: r.findings.filter((f) => f.severity === '높음').length, total: r.findings.length, at: r.at } : null,
      at: Date.now(),
    };
  }
  // 커밋, 확인 명령, 리뷰가 바뀌면 작업 보고를 다시 보낸다.
  for (const src of [verify, review, commit, settings]) src.on('changed', () => assignments.poke());

  const digest = new DigestService({
    db,
    projects: () => projects.list(),
    workspaceName: (id) => { const w = workspaces.get(id); return !w ? '' : w.role === 'coordinator' ? '조율' : w.name; },
    workMs: (day) => { try { const [y, m] = day.split('-').map(Number); return worktime.month(y!, m!).find((x) => x.day === day)?.totalMs ?? 0; } catch { return 0; } },
    attention: () => attention.list().map((a) => ({ title: a.title, projectName: a.projectName })),
  });

  const schedules = new ScheduleService({
    db,
    workspace: (id) => workspaces.get(id),
    isProjectClosed: (id) => service.isProjectClosed(id),
    blocked: (id) => budget.blocked(id),
    send: (projectId, workspaceId, body, title) => { messages.send({ projectId, from: { kind: 'system' }, toWorkspaceId: workspaceId, body, title }); },
  });
  if (o.networkProbe !== null) schedules.start();
  const captures = new CaptureStore({ db, addTodo: (projectId, workspaceId, title, detail) => { todos.add({ projectId, workspaceId, title, detail }, 'user'); } });

  /** 자리 비움 동안 온 선택지 질문에 대신 답하고, 무엇을 골랐는지 적어 둔다. */
  function awayAnswer(workspaceId: string): void {
    const ws = workspaces.get(workspaceId);
    const q = engine.overlay(workspaceId).question;
    if (!ws || !q || !settings.get().awayMode) return;
    const answers: Record<string, string> = {};
    for (const one of q.questions) {
      const first = one.options[0]?.label;
      // 되돌리기 어려운 일로 보이면 대신 고르지 않는다: 사용자가 본 적 없는 동의가 생기지 않게 (질문의 글은 에이전트가 쓴다).
      answers[one.question] = first && !riskyChoice(`${one.question} ${one.options.map((x) => `${x.label} ${x.description ?? ''}`).join(' ')}`)
        ? first
        : first
          ? '사용자가 자리를 비웠다. 지우기, 덮어쓰기, 배포, 내보내기처럼 되돌리기 어려운 일은 대신 고르지 않는다. 이 일은 하지 말고 남겨 두어라. 이것 없이 할 수 있는 다른 일이 있으면 그것을 하라.'
          : '사용자가 자리를 비웠다. 가장 안전하다고 보는 쪽으로 스스로 정해 진행하라. 되돌리기 어려운 일이면 하지 말고 다음 일로 넘어가라.';
    }
    service.answerQuestion(workspaceId, q.requestId, answers);
    const add = db.prepare('INSERT INTO away_log (id, project_id, workspace_id, workspace_name, question, answer, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const one of q.questions) add.run(crypto.randomUUID(), ws.projectId, ws.id, ws.role === 'coordinator' ? '조율 에이전트' : ws.name, one.question.slice(0, 500), (answers[one.question] ?? '').slice(0, 500), Date.now());
    db.prepare('DELETE FROM away_log WHERE id NOT IN (SELECT id FROM away_log ORDER BY at DESC LIMIT 300)').run();
    service.emit('changed', workspaceId);
  }

  let barCache: { mark: string; value: UsageBar } | null = null;
  const feeds_ = o.feedReader ?? new FeedReader();
  const newsLinks = new Set<string>();
  let disposed = false;
  return {
    projects, repos, workspaces, service, todos, messages, delivery, chat, engine, settings, review, merges, agreements, figures, autoShip, budget, activity, doing, paddy, digest, schedules, captures, memory, plugins, makes, cleanup, coordinator, dbs, slack, updates, notes, attention, usage, checkpoints, prs, verify, worktime, browser, peers, assignments, commitDrafts, commit,
    async news(force = false) {
      const panels = plugins.panels();
      const out: NewsPanel[] = [];
      for (const pn of panels) {
        const feeds = await Promise.all(pn.feeds.map(async (f) => { const r = await feeds_.read(f.url, force); return { name: f.name, url: f.url, items: r.items.slice(0, 12), error: r.error, at: r.at }; }));
        for (const f of feeds) for (const it of f.items) if (it.link) newsLinks.add(it.link);
        out.push({ plugin: pn.plugin, title: pn.title, feeds });
      }
      // 끝없이 쌓이지 않게
      if (newsLinks.size > 5000) { const keep = [...newsLinks].slice(-2500); newsLinks.clear(); for (const k of keep) newsLinks.add(k); }
      return out;
    },
    knownNewsLink(url) { return newsLinks.has(String(url)); },
    projectView(projectId) {
      const r = db.prepare('SELECT role, custom FROM project_views WHERE project_id = ?').get(String(projectId)) as { role: string; custom: string } | undefined;
      if (!r) return { role: '', custom: {} };
      let custom: unknown = {};
      try { custom = JSON.parse(r.custom); } catch { /* 깨졌으면 기본 구성 */ }
      return cleanViewPref(r.role, custom);
    },
    setProjectView(projectId, role, custom) {
      if (!projects.get(String(projectId))) throw new Error('프로젝트가 없습니다.');
      const pref = cleanViewPref(role, custom);
      db.prepare('INSERT INTO project_views (project_id, role, custom) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET role = excluded.role, custom = excluded.custom').run(String(projectId), pref.role, JSON.stringify(pref.custom));
      return pref;
    },
    agentConfig(workspaceId) {
      const ws = workspaces.get(workspaceId);
      if (!ws || ws.role === 'coordinator' || !existsSync(ws.worktreePath)) return { files: [], hash: '', trusted: true };
      const cfg = readAgentConfig(ws.worktreePath);
      return { ...cfg, trusted: !cfg.hash || db.prepare('SELECT 1 FROM agent_config_trust WHERE repo_id = ? AND hash = ?').get(ws.repoId, cfg.hash) !== undefined };
    },
    trustAgentConfig(workspaceId, hash) {
      const ws = workspaces.get(workspaceId);
      if (!ws) throw new Error('워크스페이스가 없습니다.');
      const cfg = readAgentConfig(ws.worktreePath);
      if (!cfg.hash || cfg.hash !== String(hash)) throw new Error('보는 사이에 내용이 바뀌었습니다. 다시 확인하세요.');
      db.prepare('INSERT OR IGNORE INTO agent_config_trust (repo_id, hash, at) VALUES (?, ?, ?)').run(ws.repoId, cfg.hash, Date.now());
      service.emit('changed', ws.projectId);
    },
    awayChoices() {
      return (db.prepare('SELECT * FROM away_log ORDER BY at DESC LIMIT 100').all() as { id: string; project_id: string; workspace_id: string; workspace_name: string; question: string; answer: string; at: number }[])
        .map((r) => ({ id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, workspaceName: r.workspace_name, question: r.question, answer: r.answer, at: r.at }));
    },
    clearAwayChoices(id?: string) {
      if (id) db.prepare('DELETE FROM away_log WHERE id = ?').run(String(id)); else db.prepare('DELETE FROM away_log').run();
      service.emit('changed', '');
    },
    usageBar() {
      // 사용량 기록이 그대로면 (같은 날, 같은 줄 수) 다시 훑지 않는다: 한도와 일하는 수만 새로 붙인다.
      const mark = `${new Date().toDateString()}:${(db.prepare('SELECT count(*) AS n, coalesce(max(rowid), 0) AS r FROM token_usage').get() as { n: number; r: number }).n}`;
      const live = (): Pick<UsageBar, 'limit' | 'windows' | 'working'> => ({
        limit: service.accountLimit(), windows: service.limitWindows(),
        working: projects.list().flatMap((p) => workspaces.listAll(p.id)).filter((w) => w.status === 'working').length,
      });
      if (barCache && barCache.mark === mark) return { ...barCache.value, ...live() };
      const COUNTED = 'coalesce(sum(input + cache_write + output), 0)';
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const t0 = start.getTime();
      const today = db.prepare(`SELECT ${COUNTED} AS counted, coalesce(sum(cache_read), 0) AS cacheRead, coalesce(sum(output), 0) AS output, count(*) AS requests FROM token_usage WHERE at >= ?`).get(t0) as UsageBar['today'];
      const byDay = new Map((db.prepare(`SELECT at, input + cache_write + output AS n FROM token_usage WHERE at >= ?`).all(t0 - 6 * 86_400_000) as { at: number; n: number }[])
        .reduce((m, r) => m.set(dayOf(r.at), (m.get(dayOf(r.at)) ?? 0) + r.n), new Map<string, number>()));
      const week = Array.from({ length: 7 }, (_, i) => byDay.get(dayOf(t0 - (6 - i) * 86_400_000 + 3_600_000)) ?? 0);
      const names = new Map(projects.list().map((p) => [p.id, p.name]));
      const projectsToday = (db.prepare(`SELECT project_id, ${COUNTED} AS n FROM token_usage WHERE at >= ? GROUP BY project_id ORDER BY n DESC LIMIT 8`).all(t0) as { project_id: string; n: number }[])
        .map((r) => ({ projectId: r.project_id, name: names.get(r.project_id) ?? '지운 프로젝트', counted: r.n }));
      const models = (db.prepare(`SELECT model, ${COUNTED} AS n FROM token_usage WHERE at >= ? AND model NOT LIKE '<%' GROUP BY model ORDER BY n DESC`).all(t0) as { model: string; n: number }[])
        .map((r) => ({ model: r.model || '(알 수 없음)', counted: r.n }));
      const since = (t: number): number => (db.prepare(`SELECT ${COUNTED} AS n FROM token_usage WHERE at >= ?`).get(t) as { n: number }).n;
      const monday = new Date(start); monday.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const first = new Date(start); first.setDate(1);
      const periods = { today: today.counted, week: since(monday.getTime()), month: since(first.getTime()) };
      const working = projects.list().flatMap((p) => workspaces.listAll(p.id)).filter((w) => w.status === 'working').length;
      const value = { today, week, periods, projects: projectsToday, models, limit: service.accountLimit(), windows: service.limitWindows(), working };
      barCache = { mark, value };
      return value;
    },
    dashboard() {
      const att = new Map<string, number>();
      for (const a of attention.list()) if (a.projectId) att.set(a.projectId, (att.get(a.projectId) ?? 0) + 1);
      return projects.list().filter((p) => p.status !== 'done').map((p): ProjectDashboard => {
        const all = todos.listProject(p.id).filter((t) => t.status !== 'cancelled');
        const ws = workspaces.list(p.id);
        const b = budget.status(p.id);
        const ship = autoShip.events(p.id)[0];
        const share = peers.share(p.id);
        return {
          projectId: p.id,
          todos: { total: all.length, done: all.filter((t) => t.status === 'done').length, doing: all.filter((t) => t.status === 'doing').length },
          agents: { working: ws.filter((w) => w.status === 'working').length, waiting: ws.filter((w) => w.status === 'waiting_user').length, total: ws.length },
          attention: att.get(p.id) ?? 0,
          budget: { today: b.today, dailyLimit: b.dailyLimit, state: b.state },
          lastShip: ship ? { at: ship.at, stage: ship.stage, ok: ship.ok, workspaceName: ship.workspaceName } : null,
          share: share ? { mine: share.mine, observer: share.observer, people: share.members.length - 1, online: share.members.filter((m) => !m.me && m.online).length } : null,
        };
      });
    },
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
      makes.removeProject(projectId);
      db.prepare('DELETE FROM project_views WHERE project_id = ?').run(projectId);
      // 조율 에이전트의 폴더는 두레의 것이다. 함께 지운다.
      const coordDir = join(o.dataDir, 'coordinators', projectId);
      if (coordDir.startsWith(join(o.dataDir, 'coordinators') + sep)) rmSync(coordDir, { recursive: true, force: true });
      projects.remove(projectId);
    },
    async doctor() {
      let claude: string | null = null;
      try { claude = service.claudeExecutable(); } catch { /* 없다 */ }
      const gitVersion = await git.raw(['--version']).then((s) => s.trim(), () => null);
      // 로그인: Claude Code 가 모델 목록을 알려 주면 로그인한 것이다 (받아 둔 목록이 있으면 그것으로 본다).
      let loggedIn: boolean | null = null;
      if (claude) loggedIn = engine.models().length > 0 ? true : await service.loadModels().then((m) => m.length > 0, () => null);
      return { claude, git: gitVersion, loggedIn };
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
        limit: service.limitOf(workspaceId),
        stuck: service.stuckOf(workspaceId),
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
      doing.dispose();
      schedules.dispose();
      chat.dispose();
      await engine.stopAll();
      assignments.dispose();
      autoShip.dispose();
      for (const t of reviewTimers.values()) clearTimeout(t);
      await peers.dispose();
      await pty.killAll();
      await mcp.close();
      db.close();
    },
  };
}
