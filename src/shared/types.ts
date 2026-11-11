export type AgentKind = 'claude' | 'codex';
export type PermissionMode = 'ask' | 'bypass';
export type WorkspaceStatus = 'stopped' | 'idle' | 'working' | 'waiting_user';

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
