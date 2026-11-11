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
