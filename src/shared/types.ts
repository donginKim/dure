export type AgentKind = 'claude' | 'codex';
export type PermissionMode = 'ask' | 'bypass';
/**
 * 에이전트를 돌리는 방식.
 * chat: 터미널 화면 없이 구조화된 입출력으로 돌린다 (글이 실시간으로 흐르고, 승인과 질문이 화면의 버튼으로 온다). Claude Code 만 된다.
 * terminal: 터미널 안에서 CLI 를 그대로 띄운다.
 */
export type AgentEngine = 'chat' | 'terminal';
/**
 * starting: 에이전트를 막 띄웠고 아직 첫 신호가 오지 않았다. 폴더 신뢰 창 같은 선택 창이 떠 있을 수 있다.
 */
export type WorkspaceStatus = 'stopped' | 'starting' | 'idle' | 'working' | 'waiting_user';

/** active: 진행 중. done: 완료 처리됨 (기록만 볼 수 있고, 다시 열 수 있다) */
export type ProjectStatus = 'active' | 'done';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  status: ProjectStatus;
  /** 완료 처리한 시각. 진행 중이면 null */
  completedAt: number | null;
}

export interface Repo {
  id: string;
  projectId: string;
  name: string;
  path: string;
}

/** 등록된 저장소가 지금도 쓸 수 있는 상태인지. 화면이 등록 결과를 보여주는 데 쓴다. */
export type RepoStatus = { ok: true; branch: string } | { ok: false; reason: string };

/**
 * worker: 저장소 하나의 작업 폴더에서 일하는 보통의 워크스페이스.
 * coordinator: 프로젝트의 조율 에이전트. 프로젝트마다 하나이고, 저장소가 아니라 두레가 관리하는 폴더에서 돈다. 코드를 고치지 않는다.
 */
export type WorkspaceRole = 'worker' | 'coordinator';

export interface Workspace {
  id: string;
  projectId: string;
  role: WorkspaceRole;
  repoId: string;
  name: string;
  nameLocked: boolean;
  summary: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  agentKind: AgentKind;
  permissionMode: PermissionMode;
  engine: AgentEngine;
  status: WorkspaceStatus;
  createdAt: number;
}

export type TodoStatus = 'todo' | 'doing' | 'done' | 'cancelled';
export type TodoAssignee = 'agent' | 'user';
export type Actor = 'agent' | 'user';

export interface Todo {
  id: string;
  projectId: string;
  /** null 이면 프로젝트 범위 항목 */
  workspaceId: string | null;
  title: string;
  detail: string;
  status: TodoStatus;
  assignee: TodoAssignee;
  position: number;
  /** 값이 바뀔 때마다 1 오른다. 에이전트는 자기가 읽은 rev 를 내야 고칠 수 있다. */
  rev: number;
  updatedBy: Actor;
  createdAt: number;
  updatedAt: number;
}

export type TodoPatch = Partial<Pick<Todo, 'title' | 'detail' | 'status' | 'assignee'>>;

/** 메시지를 보낸 쪽. 워크스페이스의 에이전트, 사용자, 또는 두레 자신(알림)이다. */
export type Sender = { kind: 'workspace'; workspaceId: string } | { kind: 'user' } | { kind: 'system' };

export interface Thread {
  id: string;
  projectId: string;
  /** 첫 메시지 본문의 첫 줄 (최대 60자) */
  title: string;
  /** 사용자가 멈춤 */
  paused: boolean;
  /** 에이전트끼리 주고받은 횟수가 상한을 넘어 멈춤 */
  capped: boolean;
  /** 사용자 개입 없이 에이전트가 보낸 수 */
  agentStreak: number;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  projectId: string;
  from: Sender;
  toWorkspaceId: string;
  body: string;
  artifactIds: string[];
  createdAt: number;
  deliveredAt: number | null;
  /** 받는 워크스페이스가 지워져 전달하지 못했다 */
  failed: boolean;
}

export type ArtifactKind = 'result' | 'decision' | 'api-spec' | 'note';

/** 프로젝트 안에서 공유하는 자료. 본문이 있는 글이거나 파일 경로 링크다. 파일은 복사하지 않는다. */
export interface Artifact {
  id: string;
  projectId: string;
  /** 올린 워크스페이스. 지워졌으면 null */
  workspaceId: string | null;
  kind: ArtifactKind;
  title: string;
  body: string;
  path: string | null;
  createdAt: number;
}

/** 프로젝트 전체의 대화 흐름 상태 */
export interface ProjectFlow {
  paused: boolean;
  capped: boolean;
  agentStreak: number;
}

/** 받는 워크스페이스에 메시지가 어떻게 전달될지 */
/** waiting-start: 에이전트가 꺼져 있고, 메시지로 스스로 띄우지 않게 설정돼 있다. 사용자가 시작하면 전달된다 */
export type DeliveryState = 'none' | 'next-hook' | 'waking' | 'starting' | 'waiting-start' | 'waiting-unknown' | 'waiting-codex' | 'held';

/** 작업 폴더에서 바뀐 파일 하나 */
export interface ChangedFile {
  /** 저장소 기준 경로 */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  /** 이름이 바뀐 경우 옛 경로 */
  from?: string;
  /** 추가·삭제된 줄 수. 이진 파일이나 추적 안 된 파일은 null */
  added: number | null;
  removed: number | null;
}

/** 에이전트가 써 둔 커밋 메시지 초안. 워크스페이스마다 하나다. */
export interface CommitDraft {
  workspaceId: string;
  message: string;
  updatedAt: number;
}

export interface CommitResult {
  hash: string;
  subject: string;
}

/** 커밋 창이 보여주는 것 */
export interface CommitState {
  branch: string;
  files: ChangedFile[];
  draft: CommitDraft | null;
  /** origin 주소. 없으면 null */
  remoteUrl: string | null;
  /** 아직 push 하지 않은 커밋 수. 원격에 이 브랜치가 없으면 null */
  ahead: number | null;
  /** 병합(또는 cherry-pick, revert)이 진행 중이다. 이때는 전체를 한 번에 커밋해야 한다 */
  merging: boolean;
}

export interface TerminalInfo {
  id: string;
  workspaceId: string;
  kind: 'agent' | 'shell';
  title: string;
  /** 끝난 터미널에만 붙는다. 사용자가 탭을 닫을 때까지 목록에 남는다. */
  exitCode?: number;
}

export interface CreateWorkspaceInput {
  projectId: string;
  repoId: string;
  name?: string;
  baseBranch: string;
  agentKind: AgentKind;
  permissionMode?: PermissionMode;
  /** 주지 않으면 Claude Code 는 chat, Codex 는 terminal */
  engine?: AgentEngine;
}

/** 채팅 보기: 에이전트가 한 일 하나 (도구 호출 하나) */
export interface ChatStep {
  /** 도구 호출 id */
  id: string;
  tool: string;
  /** 한 줄 요약 (예: "git status", "LoginForm.tsx 수정") */
  summary: string;
  /** 입력 원문 (명령, 파일 경로와 바뀐 내용 등) */
  input: string;
  /** 결과 원문. 아직 없으면 null */
  output: string | null;
  status: 'running' | 'done' | 'error' | 'denied';
  startedAt: number;
  endedAt: number | null;
}

/** 채팅 보기의 대화 항목 */
export type ChatItem =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'assistant'; id: string; at: number; text: string }
  | { kind: 'steps'; id: string; at: number; steps: ChatStep[] }
  /** 두레가 넣은 글 (TODO 변경, 다른 워크스페이스의 메시지, 알림) */
  | { kind: 'dure'; id: string; at: number; title: string; text: string }
  /** 슬래시 명령이 낸 출력 (/context 등) */
  | { kind: 'output'; id: string; at: number; text: string }
  /** 중단됨, 대화가 압축됨 등 */
  | { kind: 'notice'; id: string; at: number; text: string };

export interface ChatPermission {
  tool: string;
  summary: string;
  input: string;
  /**
   * 채팅에서 "허용"/"거부" 로 답해도 되는가. 무엇을 묻는 창인지 알고, 사용자가 터미널에서 그 창을 건드리지 않았을 때만 참.
   * (답은 터미널에 Enter 나 Esc 를 써 넣는 것이라, 창의 모양을 모르면 엉뚱한 선택지가 눌린다.)
   */
  canAnswer: boolean;
  /** "앞으로 묻지 않기" 로 답할 수 있는가 (채팅 방식에서, 에이전트가 규칙을 제안했을 때) */
  canAlways?: boolean;
  /** "앞으로 묻지 않기" 를 누르면 이번 대화 동안 허용될 것 (예: "Bash: curl *"). 화면에 그대로 보인다 */
  alwaysRule?: string;
  /** 이 요청의 id (채팅 방식). 답할 때 함께 보내, 화면에 보인 바로 그 요청에만 답이 가게 한다 */
  requestId?: string;
  /** 이 뒤에 기다리는 요청 수 (채팅 방식) */
  more?: number;
}

/** 에이전트가 여러 선택지 중에서 고르라고 묻는 것 */
export interface ChatQuestion {
  /** 이 요청의 id. 답할 때 함께 보낸다 */
  requestId: string;
  questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }[];
}

/** 채팅 입력창에서 쓸 수 있는 슬래시 명령 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface ChatSnapshot {
  /** 이 워크스페이스에 채팅 보기를 쓸 수 있는가 */
  available: boolean;
  /** 쓸 수 없으면 이유 */
  reason: string | null;
  /** 대화 항목. 단계의 입력·출력 원문은 비어 있다 (펼칠 때 따로 가져온다) */
  items: ChatItem[];
  /** 너무 길어 보내지 않은 앞쪽 항목 수 */
  hidden: number;
  /** 지금 차례가 시작된 시각 (작업 중일 때) */
  workingSince: number | null;
  /** 승인을 기다리는 도구 호출 */
  pendingPermission: ChatPermission | null;
  /** 채팅으로 보냈지만 아직 에이전트에게 전달되지 않은 글 (작업 중에 보낸 글은 다음 단계에 전달된다) */
  queued: { id: string; at: number; text: string }[];
}

/** 채팅 화면이 받는 것: 대화와, 지금 입력창으로 보낼 수 있는지 */
export type ChatView = ChatSnapshot & {
  canSend: boolean;
  /** 에이전트를 돌리는 방식 */
  engine: AgentEngine;
  /** 지금 쓰고 있는 글 (채팅 방식에서 실시간으로 흐른다). 없으면 null */
  streaming: string | null;
  /** 에이전트가 고르라고 묻는 것 (채팅 방식) */
  question: ChatQuestion | null;
  /** 에이전트가 오류로 끝났을 때 남긴 글 (채팅 방식) */
  lastError: string | null;
};

/** Claude Code 의 effort 단계. 빈 값은 "Claude Code 의 기본" */
export type ClaudeEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 두레의 설정. 앱 전체에 하나다. */
export interface Settings {
  /** 새 워크스페이스의 기본 에이전트 */
  defaultAgent: AgentKind;
  /** 새 Claude Code 워크스페이스의 기본 방식 */
  defaultEngine: AgentEngine;
  /** 새 워크스페이스의 기본 권한 모드 */
  defaultPermissionMode: PermissionMode;
  /** 작업 폴더(worktree)를 만드는 상위 폴더. 빈 값이면 기본 위치 */
  worktreeRoot: string;
  /** 계획안의 새 저장소를 만드는 상위 폴더. 빈 값이면 기본 위치 */
  repoRoot: string;
  /** Claude Code 실행 파일의 절대 경로. 빈 값이면 PATH 에서 찾는다 */
  claudePath: string;
  /** Claude Code 의 모델. 빈 값이면 Claude Code 의 기본 */
  claudeModel: string;
  /** Claude Code 의 생각하는 정도(effort). 빈 값이면 Claude Code 의 기본 */
  claudeEffort: ClaudeEffort;
  /** Claude Code 에 더 줄 인자 (한 줄, 셸처럼 따옴표로 묶을 수 있다) */
  claudeArgs: string;
  codexPath: string;
  codexArgs: string;
  /** 터미널 방식에서 폴더 신뢰 창에 두레가 대신 답한다 */
  autoTrust: boolean;
  /** 사용자 개입 없이 에이전트끼리 주고받는 횟수의 상한: 대화 하나 */
  threadCap: number;
  /** 같은 상한: 프로젝트 전체 */
  projectCap: number;
  /** 꺼진 에이전트에게 메시지가 오면 스스로 띄운다 */
  autoStartOnMessage: boolean;
  /** 커밋·push 뒤에 에이전트에게 알린다 */
  notifyAgentOnCommit: boolean;
  /** 터미널 글자 크기 (px) */
  terminalFontSize: number;
  /** 채팅 글자 크기 (px) */
  chatFontSize: number;
}

/** 설정 화면이 모델을 고르게 보여줄 목록 (채팅 방식의 에이전트가 알려 준 것) */
export interface ModelChoice {
  value: string;
  name: string;
  description: string;
  /** 이 모델이 받는 effort 단계. 비어 있으면 effort 를 고를 수 없는 모델이다 */
  efforts: string[];
}

/** "정리 대기" 에 옮겨 둔 것 하나. 최종 산출물이 아닌 파일을 지우지 않고 저장소 밖으로 옮겨 둔 것이다. */
export interface CleanupItem {
  id: string;
  projectId: string;
  /** 옮긴 워크스페이스. 지워졌으면 null */
  workspaceId: string | null;
  /** 그때의 워크스페이스 이름 (워크스페이스가 지워져도 알아볼 수 있게) */
  workspaceName: string;
  /** 작업 폴더 기준의 원래 경로 */
  path: string;
  /** 왜 옮겼는지 (에이전트가 적은 것) */
  reason: string;
  /** 크기 (바이트). 폴더면 안의 것을 모두 더한 값 */
  size: number;
  isDir: boolean;
  createdAt: number;
}

/** 프로젝트를 완료 처리하기 전에 보여줄 것 */
export interface CompletionPlan {
  workspaces: {
    id: string; name: string; branch: string; worktreePath: string;
    /** 작업 폴더가 아직 있는가 */
    exists: boolean;
    /** 커밋하지 않은 변경 수. git 으로 확인하지 못했으면 null (그때는 기본으로 고르지 않는다) */
    uncommitted: number | null;
    /** git 이 무시하는 파일·폴더 수 (.env, 빌드 결과 등). 작업 폴더를 지우면 함께 지워진다. 확인하지 못했으면 null */
    ignored: number | null;
    /** push 하지 않은 커밋 수. 원격에 이 브랜치가 없으면 null */
    unpushed: number | null;
    agentRunning: boolean;
  }[];
  items: CleanupItem[];
}

/** 완료 처리할 때 사용자가 고른 것 */
export interface CompletionChoice {
  /** 작업 폴더를 지울 워크스페이스 */
  removeWorktrees: string[];
  /** 지울 정리 대기 항목 */
  removeItems: string[];
  /**
   * 목록을 볼 때의 커밋하지 않은 변경 수 (워크스페이스 id → 수). 지우기 직전에 다시 세어 이것과 다르면 지우지 않는다:
   * 목록을 본 뒤에 생긴 변경을 모르고 지우면 안 된다.
   */
  seen: Record<string, number | null>;
}

/** 계획안에 든 TODO 하나. 승인하면 그대로 만들어진다. */
export interface PlanTodo {
  title: string;
  detail: string;
  /** agent: 그 워크스페이스의 에이전트가 할 일. user: 사용자가 할 일 (결정, 커밋, 배포 등) */
  assignee: TodoAssignee;
}

/** 계획안에 든 워크스페이스 하나와 그 TODO */
/** 계획안의 새 저장소: 아직 없고, 승인하면 두레가 폴더를 만들고 git 저장소로 초기화해 프로젝트에 등록한다 */
export interface PlanRepo { name: string; description: string }

export interface ProposalItem {
  name: string;
  /** 등록된 저장소의 id */
  repoId: string;
  baseBranch: string;
  /** 이 워크스페이스가 맡을 일 (한두 줄) */
  role: string;
  /** 이 워크스페이스에 만들 TODO */
  todos: PlanTodo[];
  /** 이미 있는 워크스페이스다: 새로 만들지 않고 TODO 만 더한다 */
  existing: boolean;
}

/**
 * 조율 에이전트가 기획서를 분석해 올린 계획안. 사용자가 검토하고 승인해야 만들어진다:
 * 승인하면 두레가 워크스페이스(작업 폴더와 브랜치)와 TODO 를 화면에서 본 그대로 만든다.
 */
export interface Proposal {
  id: string;
  projectId: string;
  status: 'pending' | 'approved' | 'rejected';
  /** 기획서를 정리한 글 (마크다운): 요구사항, 범위, 불확실한 점 */
  summary: string;
  /** 승인하면 새로 만들 저장소 (맞는 저장소가 등록돼 있지 않을 때) */
  newRepos: PlanRepo[];
  items: ProposalItem[];
  /** 프로젝트 전체의 TODO (어느 워크스페이스에도 속하지 않는 일, 사용자가 결정할 것) */
  projectTodos: PlanTodo[];
  /** 조율 에이전트가 덧붙인 설명 (왜 이렇게 나눴는지) */
  note: string;
  createdAt: number;
}

/** 사용자가 검토 화면에서 고친 최종 계획 */
export interface PlanDecision {
  /** 새로 만들 저장소. items 의 repoId 가 `new:<이름>` 이면 이 목록의 저장소를 가리킨다 */
  newRepos?: PlanRepo[];
  items: ProposalItem[];
  projectTodos: PlanTodo[];
}

/** 계획안을 승인해 만든 것 */
export interface PlanResult {
  /** 새로 만들어 등록한 저장소 */
  repos: Repo[];
  created: Workspace[];
  todos: number;
}

/** 사용자가 고른 기획서 파일 */
export interface SpecFile {
  path: string;
  name: string;
  /** 글 파일이면 그 내용. 글이 아니면(PDF 등) null: 에이전트가 경로로 직접 읽는다 */
  text: string | null;
  /** 너무 길어 뒤를 잘랐는가 */
  truncated: boolean;
}

/** 프로젝트 화면의 "조율" 탭이 받는 것 */
export interface CoordinatorInfo {
  /** 조율 에이전트의 워크스페이스 (채팅 화면이 이것으로 대화한다) */
  workspace: Workspace;
  /** 승인을 기다리는 제안. 없으면 null */
  proposal: Proposal | null;
  /** 새 저장소가 만들어질 폴더 (그 아래에 저장소 이름의 폴더가 생긴다) */
  newRepoDir: string;
}

// ---- DB 조회 (5단계) ----
export type DbKind = 'postgres' | 'mysql';
/**
 * 에이전트가 이 연결을 쓰는 방식.
 * ask: 표 목록과 스키마는 바로 보고, 데이터 조회는 사용자의 승인을 받는다. auto: 바로 조회한다. off: 에이전트는 쓸 수 없다.
 */
export type DbAccess = 'ask' | 'auto' | 'off';
/** 프로젝트에 등록한 DB 연결. 비밀번호는 화면에도 에이전트에게도 나가지 않는다 */
export interface DbConnection {
  id: string; projectId: string; name: string; kind: DbKind;
  host: string; port: number; database: string; user: string; ssl: boolean;
  agentAccess: DbAccess; hasPassword: boolean; createdAt: number;
  /**
   * 이 계정이 조회 말고 할 수 있는 것 (접속해 확인한 뒤에만 있다). 비어 있지 않으면 읽기 전용 계정이 아니다:
   * "바로 조회" 로 두어도 에이전트의 조회마다 승인을 받는다.
   */
  warnings?: string[];
}
export interface DbConnectionInput {
  /** 있으면 그 연결을 고친다 */
  id?: string;
  projectId: string; name: string; kind: DbKind;
  host: string; port: number; database: string; user: string; ssl: boolean; agentAccess: DbAccess;
  /** 고칠 때 비우면(undefined) 저장된 비밀번호를 그대로 둔다 */
  password?: string;
}
export interface DbTable { schema: string; name: string; type: 'table' | 'view' }
export interface DbColumn { name: string; type: string; nullable: boolean; default: string | null; key: string }
export type DbCell = string | number | boolean | null;
export interface DbResult { columns: string[]; rows: DbCell[][]; /** 상한에 걸려 뒤가 잘렸다 */ truncated: boolean; ms: number }
/** 에이전트의 조회 요청 (승인을 받는 연결). 두레를 다시 켜면 사라진다 */
export interface DbRequest {
  id: string; projectId: string; workspaceId: string; connectionId: string; connectionName: string;
  sql: string; status: 'pending' | 'approved' | 'denied' | 'failed'; error?: string; createdAt: number;
  /** 이 연결의 계정이 조회 말고 할 수 있는 것. 승인 카드에 보인다 */
  warnings: string[];
}
