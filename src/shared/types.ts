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
  /**
   * 이 항목이 딸린 프로젝트 TODO (워크스페이스 항목만 가진다). 프로젝트 항목은 딸린 워크스페이스 항목들의 묶음이다:
   * 딸린 것이 다 끝나면 저절로 완료되고, 하나라도 시작되면 진행 중이 된다.
   */
  parentId: string | null;
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
/** 바뀐 파일 하나의 변경 내용 (통합 diff) */
export interface FileDiff {
  /** 통합 diff 글. 이진 파일이면 빈 글 */
  text: string;
  binary: boolean;
  /** 너무 길어 뒤를 잘랐다 */
  truncated: boolean;
}

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
  /**
   * 에이전트가 내장 브라우저를 쓰는가.
   * ask: 로컬 주소와 아래 허용 주소 가운데, 처음 여는 주소(호스트와 포트)마다 사용자의 허용을 받는다. local: 묻지 않는다. off: 쓰지 못한다
   */
  agentBrowser: 'ask' | 'local' | 'off';
  /** 에이전트에게 허용할 바깥 주소 (호스트를 쉼표나 공백으로 나눈다). 로컬 주소는 적지 않아도 된다 */
  agentBrowserHosts: string;
  /** 다른 사람의 두레와 연결하는가. 켜면 같은 네트워크에서 듣는다 (기본은 꺼짐) */
  peersEnabled: boolean;
  /** 다른 사람에게 보이는 내 이름. 빈 값이면 이 PC 의 사용자 이름 */
  peerName: string;
  /** 다른 두레의 연결을 받는 포트 */
  peerPort: number;
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
  /** 에이전트가 메모를 찾아 읽을 수 있다 (읽기만) */
  notesForAgents: boolean;
  /** 에이전트가 새 메모를 쓰고 메모에 덧붙일 수 있다 (고치거나 지우지는 못한다) */
  notesWriteForAgents: boolean;
  /** 에이전트나 다른 사람이 나를 기다릴 때 macOS 알림을 띄운다 */
  notifications: boolean;
  /** 근무시간을 잰다 */
  workTimeEnabled: boolean;
  /** 근무지의 와이파이 이름. 이 이름의 와이파이에 붙어 있는 동안을 근무시간으로 센다 */
  workWifi: string;
  /**
   * 세는 방식. half: 출퇴근 기록. 근무지의 와이파이에 붙으면 출근으로 적고 (30분 단위로 올림), 퇴근은 사용자가 누른다 (30분 단위로 올림).
   * minute: 붙어 있던 시간을 분 단위로 그대로 센다 (끊기면 멈춘다)
   */
  /**
   * Oracle Instant Client 가 있는 폴더. 적으면 Oracle 연결이 그 클라이언트로 접속한다 (옛 비밀번호 방식의 계정, 옛 서버).
   * 비우면 클라이언트 없이 접속한다 (설치할 것이 없다). 바꾸면 두레를 다시 켜야 듣는다
   */
  oracleClientDir: string;
  workTimeUnit: 'minute' | 'half';
  /** 출근 여유 (분). 정각·30분에서 이만큼 안에 확인되면 그 정각·30분에 출근한 것으로 적는다 (확인이 조금 늦는 것을 봐준다) */
  workGraceMin: number;
  /** 하루에 채울 근무시간 (시간, 휴게 시간을 뺀 것). 채우면 "퇴근 가능!" 을 보인다. 0 이면 보이지 않는다 */
  workDayHours: number;
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
  /** 워크스페이스 TODO 에만: 이 일이 딸릴 프로젝트 TODO 의 제목. 비어 있으면 어디에도 딸리지 않는다 */
  under?: string;
  /** 나눠 준 쪽의 기록에만: 이 일이 딸린 내 프로젝트 TODO 의 id (승인할 때 두레가 적는다. 상대에게 보내지 않는다) */
  goal?: string;
}

/** 계획안에 든 워크스페이스 하나와 그 TODO */
/** 계획안의 새 저장소: 아직 없고, 승인하면 두레가 폴더를 만들고 git 저장소로 초기화해 프로젝트에 등록한다 */
export interface PlanRepo { name: string; description: string }
/** 계획안이 등록하자고 하는, PC 에 이미 있는 git 저장소 폴더. 승인하면 이 프로젝트의 저장소로 등록한다 (폴더는 건드리지 않는다) */
export interface PlanFolder { path: string; name: string; /** origin 원격의 주소 (없으면 빈 글) */ remote: string }

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
  /**
   * 맡을 사람. 빈 값이면 나 (내 PC 에 만든다). 함께하는 사람의 id 이면 그 사람에게 배정으로 보낸다:
   * 그 사람이 수락해야 그 사람의 PC 에 만들어진다. 이때 저장소와 기준 브랜치는 그 사람이 고른다.
   */
  owner?: string;
}

/**
 * 조율 에이전트가 기획서를 분석해 올린 계획안. 사용자가 검토하고 승인해야 만들어진다:
 * 승인하면 두레가 워크스페이스(작업 폴더와 브랜치)와 TODO 를 화면에서 본 그대로 만든다.
 */
export interface Proposal {
  id: string;
  projectId: string;
  status: 'pending' | 'approved' | 'rejected';
  /** 함께하는 사람이 제안해 온 계획안이면 그 사람 (내가 연 프로젝트에서만). 내 조율 에이전트가 올린 것이면 없다 */
  suggestedBy?: { peerId: string; name: string };
  /** 기획서를 정리한 글 (마크다운): 요구사항, 범위, 불확실한 점 */
  summary: string;
  /** 승인하면 새로 만들 저장소 (맞는 저장소가 등록돼 있지 않을 때) */
  newRepos: PlanRepo[];
  /** 승인하면 등록할, PC 에 이미 있는 저장소 폴더 */
  addRepos: PlanFolder[];
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
  addRepos?: PlanFolder[];
  items: ProposalItem[];
  projectTodos: PlanTodo[];
  /** 일을 받지 않는 사람을 포함해, 함께하는 사람 모두에게 기획서 정리를 보낸다 */
  shareSummary?: boolean;
}

/** 계획안을 승인해 만든 것 */
export interface PlanResult {
  /** 다른 사람에게 보낸 배정의 수 */
  assigned: number;
  /** 새로 만들어 등록한 저장소 */
  repos: Repo[];
  created: Workspace[];
  todos: number;
  /** 만들지 않고 프로젝트를 연 사람에게 제안으로 보냈다 (내가 연 프로젝트가 아닐 때) */
  suggested?: boolean;
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
  /** 함께하는 사람들 (일을 나눠 줄 수 있는 사람). 함께하는 프로젝트가 아니면 비어 있다 */
  people: { peerId: string; name: string; online: boolean }[];
  /**
   * 다른 사람이 연 프로젝트에 참여하고 있을 때: 그 사람(리더)의 이름. 이때 계획안은 승인해도 만들어지지 않고
   * 리더에게 제안으로 간다. 내가 연 프로젝트이거나 함께하는 프로젝트가 아니면 없다
   */
  suggestTo?: string;
}

// ---- DB 조회 (5단계) ----
export type DbKind = 'postgres' | 'mysql' | 'oracle' | 'mongo';
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

/** 에이전트가 처음 여는 주소를 열어도 되는지 묻는 요청. 두레를 다시 켜면 사라진다 */
export interface BrowserRequest {
  id: string; projectId: string; workspaceId: string;
  /** 허용의 단위: 프로토콜, 호스트, 포트 (예: http://localhost:3000) */
  origin: string;
  url: string; createdAt: number;
}

// ---- 다른 사람의 두레와 연결 ----
/** 그 사람의 에이전트가 보낸 메시지를 받는 방식. review: 내가 보고 넘겨준다. direct: 바로 내 에이전트에게 전달한다 */
export type PeerMode = 'review' | 'direct';
/** 연결된 사람 (다른 PC 의 두레) */
export interface Peer {
  id: string; name: string;
  /** 열쇠의 짧은 지문 */
  fingerprint: string;
  address: string; mode: PeerMode;
  /** 내가 직접 연결했는가. 아니면 함께하는 프로젝트의 참여자로 알게 된 사람이다 */
  direct: boolean;
  /** 같은 네트워크에서 지금 보이는가 */
  online: boolean;
  createdAt: number;
}
/** 연결 요청. in: 받은 것(내가 수락한다), out: 보낸 것(상대의 수락을 기다린다) */
export interface PeerRequest {
  id: string; peerId: string; name: string; address: string; fingerprint: string;
  /** 두 화면에 같아야 하는 확인 코드 */
  code: string;
  direction: 'in' | 'out';
  /** 내가 코드를 확인하고 연결을 눌렀다 */
  confirmed: boolean;
  /** 상대가 코드를 확인하고 연결을 눌렀다. 둘 다 눌러야 연결된다 */
  peerConfirmed: boolean;
  /** 이미 연결된 사람인데 열쇠가 달라졌다 (두레를 다시 깔았거나, 누가 그 사람인 척한다) */
  keyChanged: boolean;
  createdAt: number;
}
/** 같은 네트워크에서 보이는 두레 */
export interface FoundPeer { peerId: string; name: string; address: string; known: boolean }
export interface PeerStatus {
  enabled: boolean; id: string; name: string; fingerprint: string;
  /** 듣고 있는 포트. 꺼져 있거나 열지 못했으면 null */
  port: number | null;
  /** 켰는데 열지 못한 이유 */
  error?: string;
}
export interface ShareMember { peerId: string; name: string; me: boolean; owner: boolean; online: boolean }
/** 함께하는 프로젝트. 내 프로젝트 하나에 이어 붙어 있다 */
export interface Share {
  id: string; name: string; projectId: string; ownerPeerId: string; mine: boolean; members: ShareMember[];
  /**
   * 참여자가 제안한 계획안을 어떻게 받을지 (내가 연 프로젝트에서 내가 정한다).
   * review: 내가 검토하고 승인해야 반영된다. auto: 다른 사람에게 일을 나눠 주기만 하는 제안은 승인 없이 반영한다 (내 PC 에 만들거나 프로젝트 TODO 를 더하는 제안은 검토로 남는다)
   */
  suggestMode: 'review' | 'auto';
  /** 초대했지만 아직 참여하지 않은 사람 (내가 연 프로젝트에서만) */
  invited: { peerId: string; name: string }[];
}
export interface ShareInvite { id: string; shareId: string; name: string; fromPeerId: string; fromName: string; createdAt: number }
/** 워크스페이스를 누구에게 보일지. none: 아무에게도. all: 참여자 전체. selected: 고른 사람만 */
export type SharingAudience = 'none' | 'all' | 'selected';
export interface WorkspaceSharing { workspaceId: string; audience: SharingAudience; peers: string[] }
/** 다른 사람이 나에게 공개한 워크스페이스 */
export interface RemoteWorkspace {
  /** 메시지의 보낸 쪽·받는 쪽에 들어가는 id */
  ref: string;
  shareId: string; projectId: string; peerId: string; peerName: string; name: string;
  /** 에이전트와 화면에 보이는 이름: 워크스페이스@사람 */
  label: string;
}
/** 다른 사람의 에이전트가 보낸 메시지 중, 내가 보고 넘겨주기를 기다리는 것 */
export interface HeldMessage {
  /** toWorkspaceId 가 비어 있으면 워크스페이스가 아니라 나에게 온 질문이다 (toPerson) */
  id: string; projectId: string; fromRef: string; fromLabel: string; toWorkspaceId: string; toPerson: boolean;
  body: string; artifacts: { kind: string; title: string; body: string }[]; createdAt: number;
}

// ---- 배정: 계획안의 일을 함께하는 사람에게 나눠 주기 ----
/** 배정 하나에 든 워크스페이스 (받는 사람의 PC 에 만들어질 것) */
export interface AssignItem { name: string; role: string; todos: PlanTodo[] }
/** 나눠 받은 일의 진행. 나눠 준 사람에게 보인다 (읽기 전용) */
export interface AssignProgress { workspaceId: string; name: string; status: string; summary: string; todos: { title: string; status: string; assignee: string }[] }
/** 내가 나눠 준 일 */
export interface AssignmentOut {
  id: string; projectId: string; peerId: string; peerName: string;
  /** sent: 상대의 수락을 기다린다. accepted: 상대가 받아 만들었다. declined: 거절했다 */
  state: 'sent' | 'accepted' | 'declined';
  items: AssignItem[]; progress: AssignProgress[];
  /** 거절한 이유 등 */
  note: string; createdAt: number; updatedAt: number;
}
/** 현황판의 큰 일 하나 (리더의 프로젝트 TODO). done/total 은 거기에 딸린 일의 수 (취소한 것은 빼고) */
export interface BoardGoal { title: string; status: TodoStatus; assignee: TodoAssignee; done: number; total: number }
/**
 * 현황판의 워크스페이스 하나. 제목과 수만 담는다 (TODO 의 내용은 담지 않는다).
 * state: active 진행이 보인다. waiting 맡을 사람의 수락을 기다린다. unknown 맡았지만 진행을 받지 못했다 (공개하지 않았다)
 */
export interface BoardWork { name: string; role: string; status: string; done: number; total: number; state: 'active' | 'waiting' | 'unknown' }
export interface BoardPerson { peerId: string; name: string; me: boolean; leader: boolean; works: BoardWork[] }
/**
 * 함께하는 프로젝트의 현황판: 큰 일과 누가 무엇을 맡았는지. 프로젝트를 연 사람(리더)의 두레가 만들어 모두에게 보낸다.
 * 리더에게는 지금의 것, 나머지에게는 마지막으로 받은 것이다 (updatedAt).
 */
export interface Board {
  projectId: string;
  /** 내가 리더다 (이 현황판을 내 두레가 만든다) */
  mine: boolean;
  leaderName: string;
  /** 기획서 정리 (가장 최근에 승인된 계획안의 것) */
  summary: string;
  goals: BoardGoal[];
  people: BoardPerson[];
  updatedAt: number;
}
/** 내가 받은 배정 */
export interface AssignmentIn {
  id: string; projectId: string; fromPeerId: string; fromName: string;
  /** 기획서 정리 (마크다운) */
  summary: string;
  items: AssignItem[]; state: 'pending' | 'accepted' | 'declined'; createdAt: number;
}
/** 받은 배정을 수락할 때, 워크스페이스마다 어디에 만들지 */
export interface AssignChoice {
  /** 내 프로젝트에 등록된 저장소. 빈 값이면 newRepo 를 만든다 */
  repoId: string;
  /** 새로 만들 저장소의 이름 (repoId 가 없을 때) */
  newRepo?: string;
  /** 워크스페이스의 이름을 바꾸고 싶을 때 */
  name?: string;
}

/** 대화에 붙여 보내는 이미지 (붙여넣기). data 는 base64 */
export interface ChatImage { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** 한 번에 보낼 수 있는 이미지의 수와 한 장의 크기 (바이트) */
export const MAX_CHAT_IMAGES = 5;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

// ---- 슬랙 읽기 ----
/** 에이전트가 슬랙을 읽을 때: ask 물어보고 읽기, auto 바로 읽기, off 읽지 못함 */
export type SlackAccess = 'ask' | 'auto' | 'off';
export interface SlackStatus { connected: boolean; team: string; user: string; access: SlackAccess }
/** 에이전트가 올린, 결정을 기다리는 슬랙 읽기 요청. 두레를 다시 켜면 사라진다 */
export interface SlackRequest { id: string; projectId: string; workspaceId: string; /** 무엇을 읽으려는지 (사용자에게 보이는 글) */ what: string; createdAt: number }

// ---- 업데이트 (소스에서 설치한 앱) ----
export interface UpdateStatus {
  /** 여기서 업데이트할 수 있는 앱인가 (scripts/install.sh 로 넣은 앱이고, 그 소스 폴더가 남아 있다) */
  supported: boolean;
  sourceDir: string;
  /** 설치된 판 (커밋의 앞 7자) */
  installed: string;
  available: boolean;
  /** 새로 들어온 커밋의 수와 그 제목들 */
  behind: number; changes: string[];
  checkedAt: number | null; checking: boolean; error?: string;
  /** 지난 업데이트의 결과 (사용자가 닫을 때까지 남는다) */
  last: { ok: boolean; at: number } | null;
  logPath: string;
}

// ---- 메모 (프로젝트와 상관없이 하나) ----
export interface Note { id: string; title: string; body: string; createdAt: number; updatedAt: number }
/** 목록에 보이는 메모 한 줄. preview 는 찾은 낱말의 앞뒤 (찾지 않았으면 본문의 앞부분) */
export interface NoteSummary { id: string; title: string; preview: string; updatedAt: number }

// ---- 확인할 것: 에이전트나 다른 사람이 나를 기다리는 것 ----
/**
 * agent: 에이전트가 권한이나 답을 기다린다. plan: 계획안이 승인을 기다린다. db/slack/browser: 읽거나 열어도 되는지 묻는다.
 * held: 다른 사람의 메시지가 넘겨주기를 기다린다 (나에게 물은 것 포함). assign: 다른 사람이 나눠 준 일. pair: 연결 요청. invite: 프로젝트 초대
 */
export type AttentionKind = 'agent' | 'plan' | 'db' | 'slack' | 'browser' | 'held' | 'assign' | 'brief' | 'pair' | 'invite';
export interface AttentionItem {
  /** 종류와 그 요청의 id 로 만든다. 같은 것은 같은 id 다 */
  id: string; kind: AttentionKind;
  projectId: string | null; projectName: string;
  workspaceId: string | null;
  title: string; detail: string;
}

// ---- 사용량: 에이전트가 쓴 토큰 ----
export interface TokenCount {
  /** 새로 읽은 입력, 출력, 캐시에 쓴 것, 캐시에서 읽은 것 (토큰 수) */
  input: number; output: number; cacheWrite: number; cacheRead: number;
  /** 모델에 보낸 요청의 수 */
  requests: number;
}
export interface UsageRow extends TokenCount { workspaceId: string; name: string; /** 지워진 워크스페이스 */ gone: boolean }
export interface UsageSummary { total: TokenCount; workspaces: UsageRow[]; models: (TokenCount & { model: string })[]; /** 가장 먼저 적힌 기록의 시각 */ since: number | null }

// ---- 되돌리기 지점 ----
/** auto: 에이전트에게 시키기 직전에 저절로. manual: 사용자가 만듦. safety: 되돌리기 직전의 모습 (되돌린 것을 무를 때 쓴다) */
export type CheckpointKind = 'auto' | 'manual' | 'safety';
export interface Checkpoint { id: string; workspaceId: string; label: string; kind: CheckpointKind; createdAt: number }
/** 그 지점으로 되돌리면 무엇이 바뀌는지 */
export interface CheckpointPreview { files: string[]; moreFiles: number; commits: number }

// ---- PR 만들기 ----
export interface PrInfo {
  /** 어느 서비스인지 알 수 있는 원격인가 (GitHub, Bitbucket, GitLab) */
  host: 'github' | 'bitbucket' | 'gitlab' | null;
  /** PR 을 만드는 웹 화면의 주소. 모르는 원격이면 null */
  url: string | null;
  /** 두레 안에서 바로 만들 수 있는가 (GitHub 이고 gh 가 깔려 있다) */
  canCreate: boolean;
  /** 이 브랜치가 원격에 올라가 있고 올리지 않은 커밋이 없는가 */
  pushed: boolean;
  base: string; head: string;
  /** 에이전트가 적어 둔 초안, 없으면 커밋 제목들로 만든 것 */
  title: string; body: string;
}

/** 프로젝트를 연 사람이 보내 준 기획서 정리 (일을 받지 않아도 온다). 사용자가 자료로 받거나 버린다 */
export interface Brief { id: string; projectId: string; fromPeerId: string; fromName: string; summary: string; createdAt: number }

// ---- 근무시간: 근무지의 와이파이에 붙어 있는 동안을 잰다 ----
/** 근무지에 붙어 있던 한 구간 (끊겼다 다시 붙으면 새 구간) */
/** open: 출근만 하고 아직 퇴근하지 않았다 (endAt 은 마지막으로 근무지에서 확인된 시각). auto: 퇴근을 누르지 않아 두레가 닫았다 */
export interface WorkSession { id: string; day: string; startAt: number; endAt: number; open: boolean; auto: boolean }
export interface WorkDay {
  day: string;
  /** 그날의 근무시간 (ms): 출근해 있던 시간에서 휴게 시간을 뺀 것 */
  totalMs: number;
  /** 휴게 시간을 빼기 전 (ms) */
  grossMs: number;
  /** 사용자가 적은 그날의 휴게 시간 (분) */
  breakMin: number;
  firstAt: number; lastAt: number; sessions: WorkSession[];
}
export interface WorkStatus {
  enabled: boolean;
  /** 지금 근무지의 네트워크에 붙어 있는가 */
  atWork: boolean;
  /** 지금 붙어 있는 와이파이의 이름. macOS 가 알려 주지 않으면 null */
  ssid: string | null;
  /** macOS 가 와이파이 이름을 가렸다 (위치 권한이 없다). 이때는 "이 네트워크를 근무지로 기억" 으로 알아본다 */
  ssidHidden: boolean;
  /** 지금 붙어 있는 네트워크를 근무지로 기억해 두었는가 */
  remembered: boolean;
  /** 기억해 둔 네트워크의 수 */
  networks: number;
  /** 오늘 지금까지 (ms) 와 지금 구간이 시작된 시각 */
  todayMs: number; since: number | null;
  /** 출퇴근 기록 방식에서: 출근한 채로 있는 구간 (퇴근을 누를 수 있다) */
  openSession: WorkSession | null;
  /** 오늘 출근했다가 퇴근했다 (지금은 출근한 상태가 아니다) */
  clockedOut: boolean;
  unit: 'minute' | 'half';
  /** 하루에 채울 근무시간 (ms, 휴게 시간을 뺀 것). 0 이면 정해 두지 않았다 */
  targetMs: number;
}
