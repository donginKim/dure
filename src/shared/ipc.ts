import type {
  SlackAccess, SlackRequest, SlackStatus,
  ChatImage,
  AgentEngine, Artifact, ChatView, CleanupItem, CommitResult, CompletionChoice, CompletionPlan, CoordinatorInfo, ModelChoice, PlanDecision, PlanResult, Settings, SpecFile, CommitState, CreateWorkspaceInput, DeliveryState, Message, Project, ProjectFlow, Repo, RepoStatus, TerminalInfo, Thread, Todo,
  SlashCommand, TodoAssignee, TodoPatch, Workspace, DbColumn, DbConnection, DbConnectionInput, DbRequest, DbResult, DbTable, FileDiff, BrowserRequest, FoundPeer, HeldMessage, Peer, PeerMode, PeerRequest, PeerStatus, RemoteWorkspace, Share, ShareInvite, SharingAudience, WorkspaceSharing, AssignChoice, AssignmentIn, AssignmentOut,
} from './types';

export type ChangeTopic = 'projects' | 'repos' | 'workspaces' | 'terminals' | 'todos' | 'messages' | 'commit' | 'chat' | 'settings' | 'cleanup' | 'coordinator' | 'db' | 'browser' | 'peers' | 'slack';

/** 워크스페이스에 전달을 기다리는 것이 어떤 상태인지 */
export interface DeliveryInfo {
  state: DeliveryState;
  waiting: number;
  held: number;
  /** 마지막 전달 실패 이유 (에이전트를 띄우지 못함 등) */
  error?: string;
}
export interface TerminalSize { cols: number; rows: number }

/** 화면(renderer)이 `window.dure` 로 쓰는 API. */
export interface DureApi {
  projects: {
    list(): Promise<Project[]>;
    create(name: string): Promise<Project>;
    /** 기록까지 완전히 지운다. 작업 폴더는 남긴다 */
    remove(id: string): Promise<void>;
    /** 완료된 프로젝트를 다시 연다 */
    reopen(id: string): Promise<Project>;
  };
  /** 프로젝트 조율: 조율 에이전트와 그 워크스페이스 제안 */
  coordinator: {
    /** 프로젝트의 조율 에이전트(없으면 만든다)와 승인을 기다리는 제안 */
    get(projectId: string): Promise<CoordinatorInfo>;
    /** 계획안을 승인한다. decision 은 검토 화면에서 고친 최종 계획. 두레가 워크스페이스와 TODO 를 그대로 만든다 */
    approve(proposalId: string, decision: PlanDecision): Promise<PlanResult>;
    reject(proposalId: string, reason?: string): Promise<void>;
    /** 기획서 파일을 고르는 창을 띄운다. 글 파일이면 내용까지 돌려준다. 취소하면 null */
    pickSpec(): Promise<SpecFile | null>;
  };
  /** 정리 대기와 프로젝트 완료 처리 */
  db: {
    list(projectId: string): Promise<DbConnection[]>;
    /** 비밀번호를 안전하게 저장할 수 있는 환경인가 (macOS 키체인) */
    canStoreSecrets(): Promise<boolean>;
    save(input: DbConnectionInput): Promise<DbConnection>;
    remove(id: string): Promise<void>;
    /** 접속해 보고, 계정이 조회 말고 할 수 있는 것을 확인한다 */
    test(id: string): Promise<{ ms: number; warnings: string[] }>;
    tables(id: string): Promise<DbTable[]>;
    columns(id: string, schema: string, table: string): Promise<DbColumn[]>;
    /** 조회 전용. 1000행, 30초까지 */
    query(id: string, sql: string): Promise<DbResult>;
    /** 에이전트가 올린, 결정을 기다리는 조회 요청 */
    requests(projectId: string): Promise<DbRequest[]>;
    decide(requestId: string, allow: boolean, always?: boolean): Promise<void>;
  };
  cleanup: {
    list(projectId: string): Promise<CleanupItem[]>;
    /** 옮겨 둔 것을 작업 폴더의 원래 자리로 되돌린다 */
    restore(id: string): Promise<void>;
    /** 옮겨 둔 것을 고른 폴더로 꺼낸다 (되돌릴 작업 폴더가 없을 때). 폴더를 고르는 창을 띄운다. 꺼낸 경로, 취소하면 null */
    export(id: string): Promise<string | null>;
    /** 완료 처리하기 전에 보여줄 것 */
    plan(projectId: string): Promise<CompletionPlan>;
    /** 고른 것을 지우고 프로젝트를 완료로 옮긴다 */
    complete(projectId: string, choice: CompletionChoice): Promise<Project>;
  };
  repos: {
    list(projectId: string): Promise<Repo[]>;
    pickFolder(): Promise<string | null>;
    add(projectId: string, path: string): Promise<Repo>;
    branches(repoId: string): Promise<string[]>;
    /** 등록된 저장소가 지금도 유효한지와 현재 브랜치 */
    status(repoId: string): Promise<RepoStatus>;
    remove(id: string): Promise<void>;
  };
  workspaces: {
    list(projectId: string): Promise<Workspace[]>;
    create(input: CreateWorkspaceInput): Promise<Workspace>;
    remove(id: string, options: { deleteWorktree: boolean }): Promise<void>;
    /** 작업 폴더에 커밋하지 않은 변경이 몇 건인지 */
    uncommitted(id: string): Promise<number>;
    /** 작업 중인 에이전트를 멈춘다 (프로세스는 살려 둔다) */
    interrupt(id: string): Promise<void>;
    /** 에이전트를 끈다 */
    stopAgent(id: string): Promise<void>;
    /** 에이전트를 돌리는 방식을 바꾼다. 꺼져 있을 때만 된다 */
    setEngine(id: string, engine: AgentEngine): Promise<void>;
    /** 표시 이름을 바꾼다 (브랜치와 작업 폴더는 그대로). 직접 지은 이름은 에이전트가 바꾸지 못한다 */
    rename(id: string, name: string): Promise<Workspace>;
    /** 에이전트가 작업에 맞게 이름을 바꿔도 되는가 */
    setAutoName(id: string, on: boolean): Promise<Workspace>;
  };
  terminals: {
    list(workspaceId: string): Promise<TerminalInfo[]>;
    /** 터미널 방식이면 그 터미널, 채팅 방식이면 null */
    startAgent(workspaceId: string, size: TerminalSize): Promise<TerminalInfo | null>;
    openShell(workspaceId: string, size: TerminalSize): Promise<TerminalInfo>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>;
    /** 최근 출력과 그 끝 위치. onData 의 end 가 이 값 이하인 조각은 이미 담겨 있다. */
    buffer(id: string): Promise<{ data: string; end: number }>;
    onData(cb: (id: string, chunk: string, end: number) => void): () => void;
    onExit(cb: (id: string, exitCode: number) => void): () => void;
  };
  /** TODO. 화면에서 온 변경은 모두 사용자의 변경으로 기록된다. */
  todos: {
    list(projectId: string): Promise<Todo[]>;
    add(input: { projectId: string; workspaceId: string | null; title: string; assignee?: TodoAssignee }): Promise<Todo>;
    update(id: string, patch: TodoPatch): Promise<Todo>;
    remove(id: string): Promise<void>;
    move(id: string, direction: 'up' | 'down'): Promise<void>;
    /** 워크스페이스 id → 에이전트에게 아직 전달되지 않은 변경 수, 그리고 바로 알릴 수 있는지 */
    pending(projectId: string): Promise<Record<string, { count: number; canNudge: boolean }>>;
    nudge(workspaceId: string): Promise<void>;
  };
  /** 워크스페이스 사이의 대화. 화면에서 보낸 메시지는 사용자가 보낸 것으로 기록된다. */
  messages: {
    threads(projectId: string): Promise<Thread[]>;
    list(threadId: string): Promise<Message[]>;
    send(input: { projectId: string; toWorkspaceId: string; body: string; threadId?: string }): Promise<Message>;
    pauseThread(threadId: string, paused: boolean): Promise<void>;
    flow(projectId: string): Promise<ProjectFlow>;
    /** 프로젝트 전체 멈춤. 멈출 때는 작업 중인 에이전트도 중단시킨다 */
    pauseProject(projectId: string, paused: boolean): Promise<void>;
    /** "계속": 왕복 횟수를 다시 세고 상한에 걸려 붙잡힌 것을 전달한다. 사용자가 일부러 멈춘 것은 그대로 둔다 */
    resume(projectId: string): Promise<void>;
    delivery(projectId: string): Promise<Record<string, DeliveryInfo>>;
  };
  /** 커밋 창. 커밋과 push 는 사용자가 화면에서 누를 때만 실행된다 */
  commit: {
    state(workspaceId: string): Promise<CommitState>;
    /** 바뀐 파일 하나의 변경 내용 */
    diff(workspaceId: string, file: string): Promise<FileDiff>;
    run(workspaceId: string, input: { files: string[]; message: string }): Promise<CommitResult>;
    /** git 이 낸 글을 돌려준다 */
    push(workspaceId: string): Promise<string>;
  };
  /** 채팅 보기. 에이전트는 터미널에서 돌고, 여기서 보내는 것은 그 터미널에 써 넣는 것이다 */
  chat: {
    get(workspaceId: string): Promise<ChatView>;
    /** 단계 하나의 입력·출력 원문 */
    step(workspaceId: string, stepId: string): Promise<{ input: string; output: string | null } | null>;
    /** images: 붙여넣은 이미지 (대화 방식의 에이전트에게만 보낼 수 있다) */
    send(workspaceId: string, text: string, images?: ChatImage[]): Promise<void>;
    /** always: 허용하고 앞으로 같은 것은 묻지 않는다 (채팅 방식) */
    /** requestId: 화면에 보인 요청의 id (채팅 방식). 그 요청에만 답이 간다 */
    answerPermission(workspaceId: string, answer: 'allow' | 'deny' | 'always', requestId?: string): Promise<void>;
    /** 여러 선택지 질문에 답한다. answers: 질문 글 → 답 */
    answerQuestion(workspaceId: string, requestId: string, answers: Record<string, string>): Promise<void>;
    dismissQuestion(workspaceId: string, requestId: string): Promise<void>;
    /** 입력창에서 쓸 수 있는 슬래시 명령 (채팅 방식의 에이전트가 떠 있을 때) */
    commands(workspaceId: string): Promise<SlashCommand[]>;
  };
  /** 두레의 설정 (앱 전체에 하나) */
  settings: {
    get(): Promise<Settings>;
    /** 준 것만 바꾼다. 규칙에 맞지 않으면 이유를 던지고 아무것도 바꾸지 않는다 */
    update(patch: Partial<Settings>): Promise<Settings>;
    /** 기본값 */
    defaults(): Promise<Settings>;
    /** 고를 수 있는 모델. 받아 둔 것이 없으면 Claude Code 에게 물어 온다 (몇 초 걸린다). refresh: 다시 묻는다 */
    models(refresh?: boolean): Promise<ModelChoice[]>;
    /** 폴더를 고르는 창을 띄운다 */
    pickFolder(): Promise<string | null>;
  };
  artifacts: {
    list(projectId: string): Promise<Artifact[]>;
    get(id: string): Promise<Artifact | null>;
  };
  onChanged(cb: (topic: ChangeTopic) => void): () => void;
  /** 슬랙 읽기: 사용자의 토큰으로 에이전트가 슬랙을 읽는다 (읽기 전용) */
  slack: {
    status(): Promise<SlackStatus>;
    /** 토큰을 확인하고 저장한다. 토큰은 다시 돌려주지 않는다 */
    connect(token: string): Promise<SlackStatus>;
    disconnect(): Promise<void>;
    setAccess(access: SlackAccess): Promise<SlackStatus>;
    /** 에이전트가 올린, 결정을 기다리는 읽기 요청 */
    requests(projectId: string): Promise<SlackRequest[]>;
    decide(requestId: string, allow: boolean, always?: boolean): Promise<void>;
  };
  /** 배정: 계획안의 일을 함께하는 사람에게 나눠 주기 */
  assignments: {
    /** 내가 나눠 준 일과 그 진행 */
    outgoing(projectId: string): Promise<AssignmentOut[]>;
    /** 내가 받은 배정. projectId 를 주지 않으면 전부 */
    incoming(projectId?: string): Promise<AssignmentIn[]>;
    /** 수락한다: 내 프로젝트에 워크스페이스와 TODO 가 만들어진다 */
    accept(id: string, choices: AssignChoice[], share: boolean): Promise<Workspace[]>;
    decline(id: string, reason?: string): Promise<void>;
  };
  /** 다른 사람의 두레와의 연결 */
  peers: {
    status(): Promise<PeerStatus>;
    /** 같은 네트워크에서 보이는 두레 */
    found(): Promise<FoundPeer[]>;
    list(): Promise<Peer[]>;
    requests(): Promise<PeerRequest[]>;
    /** 주소(호스트:포트)의 두레에 연결을 요청한다 */
    connect(address: string): Promise<PeerRequest>;
    accept(requestId: string): Promise<void>;
    dismiss(requestId: string): Promise<void>;
    setMode(peerId: string, mode: PeerMode): Promise<void>;
    remove(peerId: string): Promise<void>;
    share(projectId: string): Promise<Share | null>;
    createShare(projectId: string): Promise<Share>;
    invite(shareId: string, peerId: string): Promise<void>;
    invites(): Promise<ShareInvite[]>;
    acceptInvite(inviteId: string, projectId: string): Promise<Share>;
    declineInvite(inviteId: string): Promise<void>;
    leave(projectId: string): Promise<void>;
    removeMember(shareId: string, peerId: string): Promise<void>;
    sharing(workspaceId: string): Promise<WorkspaceSharing>;
    setSharing(workspaceId: string, audience: SharingAudience, peers: string[]): Promise<WorkspaceSharing>;
    /** 다른 사람이 나에게 공개한 워크스페이스 */
    remote(projectId: string): Promise<RemoteWorkspace[]>;
    /** ref → "워크스페이스@사람" */
    names(): Promise<Record<string, string>>;
    /** 내가 보고 넘겨주기를 기다리는 메시지 */
    held(projectId: string): Promise<HeldMessage[]>;
    /** workspaceId: 나에게 직접 물은 것을 넘겨줄 워크스페이스 (보통 조율 에이전트) */
    pass(heldId: string, workspaceId?: string): Promise<void>;
    /** 나에게 직접 물은 것에 답한다 */
    answer(heldId: string, body: string): Promise<void>;
    drop(heldId: string): Promise<void>;
  };
  browser: {
    /** 화면이 만든 브라우저 페이지(webview)를 알린다. 에이전트의 조작이 이 페이지로 간다 */
    register(workspaceId: string, webContentsId: number): Promise<void>;
    /** 에이전트가 처음 여는 주소를 열어도 되는지 묻는 요청 */
    requests(projectId: string): Promise<BrowserRequest[]>;
    /** 허용은 그 프로젝트에서 그 주소(호스트와 포트)에 적용되고, 두레를 다시 켤 때까지 유지된다 */
    decide(requestId: string, allow: boolean): Promise<void>;
    /** 에이전트가 페이지를 열려 할 때 */
    onOpen(cb: (workspaceId: string, url: string) => void): () => void;
  };
}

/** 요청 채널. 이름은 '<묶음>.<메서드>' 이고 메인과 preload 가 이 목록 하나를 같이 쓴다. */
export const IPC_CHANNELS = [
  'projects.list', 'projects.create', 'projects.remove', 'projects.reopen',
  'coordinator.get', 'coordinator.approve', 'coordinator.reject', 'coordinator.pickSpec',
  'slack.status', 'slack.connect', 'slack.disconnect', 'slack.setAccess', 'slack.requests', 'slack.decide',
  'db.list', 'db.canStoreSecrets', 'db.save', 'db.remove', 'db.test', 'db.tables', 'db.columns', 'db.query', 'db.requests', 'db.decide',
  'cleanup.list', 'cleanup.restore', 'cleanup.export', 'cleanup.plan', 'cleanup.complete',
  'repos.list', 'repos.pickFolder', 'repos.add', 'repos.branches', 'repos.status', 'repos.remove',
  'workspaces.list', 'workspaces.create', 'workspaces.remove', 'workspaces.uncommitted', 'workspaces.interrupt',
  'workspaces.stopAgent', 'workspaces.setEngine', 'workspaces.rename', 'workspaces.setAutoName',
  'terminals.list', 'terminals.startAgent', 'terminals.openShell', 'terminals.write', 'terminals.resize',
  'terminals.kill', 'terminals.buffer',
  'todos.list', 'todos.add', 'todos.update', 'todos.remove', 'todos.move', 'todos.pending', 'todos.nudge',
  'messages.threads', 'messages.list', 'messages.send', 'messages.pauseThread', 'messages.flow', 'messages.pauseProject',
  'messages.resume', 'messages.delivery',
  'artifacts.list', 'artifacts.get',
  'peers.status', 'peers.found', 'peers.list', 'peers.requests', 'peers.connect', 'peers.accept', 'peers.dismiss', 'peers.setMode', 'peers.remove',
  'peers.share', 'peers.createShare', 'peers.invite', 'peers.invites', 'peers.acceptInvite', 'peers.declineInvite', 'peers.leave', 'peers.removeMember',
  'peers.sharing', 'peers.setSharing', 'peers.remote', 'peers.names', 'peers.held', 'peers.pass', 'peers.answer', 'peers.drop',
  'assignments.outgoing', 'assignments.incoming', 'assignments.accept', 'assignments.decline',
  'browser.register', 'browser.requests', 'browser.decide',
  'commit.state', 'commit.diff', 'commit.run', 'commit.push',
  'settings.get', 'settings.update', 'settings.defaults', 'settings.models', 'settings.pickFolder',
  'chat.get', 'chat.step', 'chat.send', 'chat.answerPermission', 'chat.answerQuestion', 'chat.dismissQuestion', 'chat.commands',
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 응답을 기다리지 않는 채널. 키 입력처럼 잦은 호출이다. */
export const IPC_ONE_WAY: readonly IpcChannel[] = ['terminals.write', 'terminals.resize'];

export const IPC_EVENTS = {
  terminalData: 'dure:terminal-data',
  terminalExit: 'dure:terminal-exit',
  changed: 'dure:changed',
  /** 에이전트가 그 워크스페이스의 브라우저 페이지를 열려 한다: 화면이 페이지를 만들고 등록한다 (workspaceId, url) */
  browserOpen: 'dure:browser-open',
} as const;

export const ipcName = (channel: IpcChannel): string => `dure:${channel}`;

/** 화면이 오류 종류를 가려낼 수 있게 메시지 앞에 붙이는 표시. */
export const ERROR_PREFIX = {
  agentNotInstalled: 'AGENT_NOT_INSTALLED:',
  worktreeMissing: 'WORKTREE_MISSING:',
} as const;
