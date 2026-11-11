export type AgentKind = 'claude' | 'codex';
export type PermissionMode = 'ask' | 'bypass';
/**
 * starting: 에이전트를 막 띄웠고 아직 첫 신호가 오지 않았다. 폴더 신뢰 창 같은 선택 창이 떠 있을 수 있다.
 */
export type WorkspaceStatus = 'stopped' | 'starting' | 'idle' | 'working' | 'waiting_user';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export interface Repo {
  id: string;
  projectId: string;
  name: string;
  path: string;
}

/** 등록된 저장소가 지금도 쓸 수 있는 상태인지. 화면이 등록 결과를 보여주는 데 쓴다. */
export type RepoStatus = { ok: true; branch: string } | { ok: false; reason: string };

export interface Workspace {
  id: string;
  projectId: string;
  repoId: string;
  name: string;
  nameLocked: boolean;
  summary: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  agentKind: AgentKind;
  permissionMode: PermissionMode;
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
export type DeliveryState = 'none' | 'next-hook' | 'waking' | 'starting' | 'waiting-unknown' | 'waiting-codex' | 'held';

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
export type ChatView = ChatSnapshot & { canSend: boolean };
