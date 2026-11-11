import type { CreateWorkspaceInput, Project, Repo, RepoStatus, TerminalInfo, Todo, TodoAssignee, TodoPatch, Workspace } from './types';

export type ChangeTopic = 'projects' | 'repos' | 'workspaces' | 'terminals' | 'todos';
export interface TerminalSize { cols: number; rows: number }

/** 화면(renderer)이 `window.dure` 로 쓰는 API. */
export interface DureApi {
  projects: {
    list(): Promise<Project[]>;
    create(name: string): Promise<Project>;
    remove(id: string): Promise<void>;
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
  };
  terminals: {
    list(workspaceId: string): Promise<TerminalInfo[]>;
    startAgent(workspaceId: string, size: TerminalSize): Promise<TerminalInfo>;
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
  onChanged(cb: (topic: ChangeTopic) => void): () => void;
}

/** 요청 채널. 이름은 '<묶음>.<메서드>' 이고 메인과 preload 가 이 목록 하나를 같이 쓴다. */
export const IPC_CHANNELS = [
  'projects.list', 'projects.create', 'projects.remove',
  'repos.list', 'repos.pickFolder', 'repos.add', 'repos.branches', 'repos.status', 'repos.remove',
  'workspaces.list', 'workspaces.create', 'workspaces.remove', 'workspaces.uncommitted',
  'terminals.list', 'terminals.startAgent', 'terminals.openShell', 'terminals.write', 'terminals.resize',
  'terminals.kill', 'terminals.buffer',
  'todos.list', 'todos.add', 'todos.update', 'todos.remove', 'todos.move', 'todos.pending', 'todos.nudge',
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 응답을 기다리지 않는 채널. 키 입력처럼 잦은 호출이다. */
export const IPC_ONE_WAY: readonly IpcChannel[] = ['terminals.write', 'terminals.resize'];

export const IPC_EVENTS = {
  terminalData: 'dure:terminal-data',
  terminalExit: 'dure:terminal-exit',
  changed: 'dure:changed',
} as const;

export const ipcName = (channel: IpcChannel): string => `dure:${channel}`;

/** 화면이 오류 종류를 가려낼 수 있게 메시지 앞에 붙이는 표시. */
export const ERROR_PREFIX = {
  agentNotInstalled: 'AGENT_NOT_INSTALLED:',
  worktreeMissing: 'WORKTREE_MISSING:',
} as const;
