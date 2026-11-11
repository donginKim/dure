import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentKind, CreateWorkspaceInput, TerminalInfo, Workspace } from '@shared/types';
import { baseInstructions } from './agents/instructions';
import { buildAgentLaunch } from './agents/launch';
import type { Git } from './git';
import type { PtyManager } from './pty';
import { slugify, uniqueSlug } from './slug';
import type { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import { pendingMessage, type TodoService } from './todos';

export type { CreateWorkspaceInput };

const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

export class AgentNotInstalledError extends Error {
  constructor(readonly kind: AgentKind) {
    super(`${AGENT_NAMES[kind]} 실행 파일을 PATH 에서 찾지 못했습니다.`);
    this.name = 'AgentNotInstalledError';
  }
}

export class WorktreeMissingError extends Error {
  constructor(readonly worktreePath: string) {
    super(`작업 폴더가 없습니다: ${worktreePath}`);
    this.name = 'WorktreeMissingError';
  }
}

export interface WorkspaceServiceDeps {
  projects: ProjectStore;
  repos: RepoStore;
  workspaces: WorkspaceStore;
  pty: PtyManager;
  todos: TodoService;
  git: Git;
  mcpUrl: string;
  hookUrl: string;
  dataDir: string;
  worktreeRoot: string;
  baseEnv: Record<string, string>;
}

function findExecutable(command: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* 다음 폴더 */ }
  }
  return undefined;
}

/**
 * 워크스페이스의 생성·삭제와 그 안의 에이전트·셸 실행을 맡는다.
 * 이벤트: 'changed' (workspaceId)
 */
export class WorkspaceService extends EventEmitter {
  /** 에이전트 터미널 id → 워크스페이스 id */
  private readonly agentTerminals = new Map<string, string>();
  /**
   * 응답을 끝냈다는 hook(Stop)으로 쉬는 중임이 확인된 워크스페이스.
   * 에이전트를 막 띄웠을 때의 'idle' 은 여기에 들지 않는다: 폴더 신뢰 창 같은 선택 창이 떠 있을 수 있다.
   */
  private readonly confirmedIdle = new Set<string>();

  private readonly onTerminalExit = (terminalId: string): void => {
    const workspaceId = this.agentTerminals.get(terminalId);
    if (!workspaceId) return;
    this.agentTerminals.delete(terminalId);
    this.confirmedIdle.delete(workspaceId);
    if (this.d.workspaces.get(workspaceId)) {
      this.d.workspaces.update(workspaceId, { status: 'stopped' });
      this.emit('changed', workspaceId);
    }
  };

  constructor(private readonly d: WorkspaceServiceDeps) {
    super();
    d.pty.on('exit', this.onTerminalExit);
  }

  /** 코어를 닫을 때 부른다. 이후의 터미널 종료는 상태 저장소를 건드리지 않는다. */
  detach(): void {
    this.d.pty.off('exit', this.onTerminalExit);
  }

  /** 워크스페이스의 터미널을 모두 끄고 실제로 끝날 때까지 (최대 3초) 기다린다. */
  private async killTerminals(workspaceId: string): Promise<void> {
    for (const t of this.d.pty.list(workspaceId)) this.d.pty.kill(t.id);
    const deadline = Date.now() + 3000;
    while (this.d.pty.list(workspaceId).length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private configDir(workspaceId: string): string {
    return join(this.d.dataDir, 'workspaces', workspaceId);
  }

  private mustGet(id: string): Workspace {
    const ws = this.d.workspaces.get(id);
    if (!ws) throw new Error(`워크스페이스가 없습니다: ${id}`);
    return ws;
  }

  async create(i: CreateWorkspaceInput): Promise<Workspace> {
    const project = this.d.projects.get(i.projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${i.projectId}`);
    const repo = this.d.repos.get(i.repoId);
    if (!repo || repo.projectId !== project.id) throw new Error(`이 프로젝트에 등록된 저장소가 아닙니다: ${i.repoId}`);

    const typed = i.name?.trim();
    const name = typed || `${repo.name}-${this.d.workspaces.list(project.id).length + 1}`;
    const projectDir = join(this.d.worktreeRoot, slugify(project.name));
    const branches = new Set(await this.d.git.listBranches(repo.path));
    const slug = uniqueSlug(slugify(name), (c) => branches.has(`dure/${c}`) || existsSync(join(projectDir, c)));
    const branch = `dure/${slug}`;
    const worktreePath = join(projectDir, slug);

    mkdirSync(projectDir, { recursive: true });
    // worktree 가 먼저다. 실패하면 행을 만들지 않아 반쪽짜리 워크스페이스가 남지 않는다.
    // git 은 브랜치를 만든 뒤 체크아웃하므로, 도중에 실패하면 브랜치가 남는다. 그것도 치운다.
    const undo = async (): Promise<void> => {
      await this.d.git.removeWorktree({ repoPath: repo.path, worktreePath }).catch(() => undefined);
      if (await this.d.git.branchExists(repo.path, branch)) await this.d.git.deleteBranch(repo.path, branch).catch(() => undefined);
    };
    try {
      await this.d.git.addWorktree({ repoPath: repo.path, worktreePath, branch, baseBranch: i.baseBranch });
    } catch (e) {
      await undo();
      throw e;
    }
    try {
      const ws = this.d.workspaces.insert({
        id: crypto.randomUUID(), projectId: project.id, repoId: repo.id, name, nameLocked: Boolean(typed),
        branch, baseBranch: i.baseBranch, worktreePath, agentKind: i.agentKind,
        permissionMode: i.permissionMode ?? 'ask', token: randomBytes(32).toString('hex'),
      });
      this.emit('changed', ws.id);
      return ws;
    } catch (e) {
      await undo();
      throw e;
    }
  }

  async remove(id: string, o: { deleteWorktree: boolean }): Promise<void> {
    const ws = this.mustGet(id);
    // 작업 폴더를 지우기 전에 그 안에서 도는 프로세스를 먼저 끝낸다.
    await this.killTerminals(id);
    if (o.deleteWorktree) {
      const repo = this.d.repos.get(ws.repoId);
      if (repo) await this.d.git.removeWorktree({ repoPath: repo.path, worktreePath: ws.worktreePath });
    }
    this.d.pty.forgetExited(id);
    this.d.todos.removeWorkspace(id);
    this.d.workspaces.remove(id);
    rmSync(this.configDir(id), { recursive: true, force: true });
    this.emit('changed', id);
  }

  async startAgent(id: string, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    const ws = this.mustGet(id);
    const running = this.d.pty.list(id).find((t) => t.kind === 'agent');
    if (running) return running;
    this.d.pty.forgetExited(id, 'agent'); // 지난 에이전트 탭 기록은 치운다
    if (!existsSync(ws.worktreePath)) throw new WorktreeMissingError(ws.worktreePath);

    const project = this.d.projects.get(ws.projectId)!;
    const launch = buildAgentLaunch({
      kind: ws.agentKind,
      permissionMode: ws.permissionMode,
      mcpUrl: this.d.mcpUrl,
      hookUrl: this.d.hookUrl,
      token: this.d.workspaces.getToken(id),
      configDir: this.configDir(id),
      instructions: baseInstructions(ws, project),
    });
    const executable = findExecutable(launch.command, this.d.baseEnv.PATH);
    if (!executable) throw new AgentNotInstalledError(ws.agentKind);

    for (const f of launch.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      const mode = f.mode ?? 0o600; // 토큰이 들어 있다
      writeFileSync(f.path, f.content, { mode });
      chmodSync(f.path, mode); // 이미 있던 파일은 writeFileSync 가 권한을 바꾸지 않는다
    }
    const terminal = this.d.pty.spawn({
      workspaceId: id, kind: 'agent', title: AGENT_NAMES[ws.agentKind],
      command: executable, args: launch.args, cwd: ws.worktreePath,
      env: { ...this.d.baseEnv, ...launch.env }, cols: size.cols, rows: size.rows,
    });
    this.agentTerminals.set(terminal.id, id);
    // 새 대화는 이전 목록을 본 적이 없다. 꺼져 있던 동안의 변경 기록은 버리고, 목록은 에이전트가 todo_list 로 읽는다.
    this.d.todos.takePending(id);
    this.d.workspaces.update(id, { status: 'idle' });
    this.emit('changed', id);
    return terminal;
  }

  /**
   * 쉬는 에이전트에게 미전달 TODO 변경을 바로 알릴 수 있는가.
   * 터미널에 글을 써 넣는 방식이라, hook 신호로 쉬는 중임이 확인된 Claude Code 에서만 허용한다.
   * (선택 창이 떠 있을 수 있는 터미널에 써 넣으면 의도하지 않은 동작이 실행된다.)
   */
  /** hook 이 올 때마다 부른다. 응답을 그냥 끝낸 Stop 만 쉬는 중의 근거가 된다. */
  noteHook(id: string, event: string, blocked: boolean): void {
    if (event === 'Stop' && !blocked) this.confirmedIdle.add(id);
    else this.confirmedIdle.delete(id);
  }

  canNudge(id: string): boolean {
    const ws = this.d.workspaces.get(id);
    if (!ws || ws.agentKind !== 'claude' || ws.status !== 'idle' || !this.confirmedIdle.has(id)) return false;
    if (!this.d.pty.list(id).some((t) => t.kind === 'agent')) return false;
    return this.d.todos.pendingCount(id) > 0;
  }

  /** 미전달 TODO 변경을 쉬는 에이전트의 터미널에 써 넣어 깨운다. */
  async nudge(id: string): Promise<void> {
    if (!this.canNudge(id)) throw new Error('에이전트가 쉬는 중일 때만 알릴 수 있습니다.');
    const terminal = this.d.pty.list(id).find((t) => t.kind === 'agent')!;
    const lines = this.d.todos.takePending(id);
    // 제목의 제어 문자는 저장할 때 걸러지지만, 터미널에 쓰는 글은 여기서 한 번 더 거른다.
    // eslint-disable-next-line no-control-regex
    const message = pendingMessage(lines).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    // 쓰기 전에 상태를 바꿔 같은 내용을 두 번 보내지 못하게 한다.
    this.confirmedIdle.delete(id);
    this.d.workspaces.update(id, { status: 'working' });
    this.emit('changed', id);
    // 여러 줄은 붙여넣기로 묶어 넣고, 잠시 뒤 Enter 를 따로 보낸다 (실험 03).
    this.d.pty.write(terminal.id, `\x1b[200~${message}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 400));
    if (!this.d.pty.list(id).some((t) => t.id === terminal.id)) {
      // 그사이 에이전트가 끝났다. 변경이 사라지지 않게 되돌려 놓는다.
      this.d.todos.restorePending(id, lines);
      throw new Error('에이전트가 종료되어 전달하지 못했습니다.');
    }
    this.d.pty.write(terminal.id, '\r');
  }

  /** 작업 폴더에 커밋하지 않은 변경이 몇 건인지. 폴더가 없으면 0. */
  async uncommittedCount(id: string): Promise<number> {
    const ws = this.mustGet(id);
    return existsSync(ws.worktreePath) ? this.d.git.uncommittedCount(ws.worktreePath) : 0;
  }

  async openShell(id: string, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    const ws = this.mustGet(id);
    if (!existsSync(ws.worktreePath)) throw new WorktreeMissingError(ws.worktreePath);
    return this.d.pty.spawn({
      workspaceId: id, kind: 'shell', title: '셸',
      command: this.d.baseEnv.SHELL || '/bin/zsh', args: ['-l'], cwd: ws.worktreePath,
      env: this.d.baseEnv, cols: size.cols, rows: size.rows,
    });
  }
}
