import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentKind, CreateWorkspaceInput, TerminalInfo, Workspace, Settings, ModelChoice } from '@shared/types';
import { baseInstructions, coordinatorInstructions } from './agents/instructions';
import { buildAgentLaunch, HEADLESS_ARGS } from './agents/launch';
import { trustPrompt } from './agents/trustPrompt';
import type { ChatService } from './chat/chatService';
import type { ChatEngine } from './chat/engine';
import { DEFAULT_SETTINGS, expandHome, parseArgs, reservedArg } from './settings';
import type { DeliveryService } from './delivery';
import type { Git } from './git';
import type { MessageService } from './messages';
import type { PtyManager } from './pty';
import { slugify, uniqueSlug } from './slug';
import type { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import type { TodoService } from './todos';

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
  messages: MessageService;
  git: Git;
  mcpUrl: string;
  hookUrl: string;
  dataDir: string;
  worktreeRoot: string;
  baseEnv: Record<string, string>;
  /** 두레의 설정. 없으면 기본값으로 동작한다 */
  settings?: () => Settings;
}

const DONE_PROJECT = '완료된 프로젝트입니다. 다시 열어야 워크스페이스를 만들거나 에이전트를 시작할 수 있습니다.';

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

/** 조율 에이전트의 이름. 보통 워크스페이스는 이 이름을 쓸 수 없다 */
export const COORDINATOR_NAME = '조율';

const MAX_NAME = 40;
const MAX_SUMMARY = 80;
/** 에이전트가 이름을 다시 바꿀 수 있을 때까지의 간격 */
const RENAME_GAP_MS = 5 * 60_000;

export class WorkspaceService extends EventEmitter {
  /** 에이전트 터미널 id → 워크스페이스 id */
  private readonly agentTerminals = new Map<string, string>();
  /**
   * 응답을 끝냈다는 hook(Stop)으로 쉬는 중임이 확인된 워크스페이스.
   * 에이전트를 막 띄웠을 때의 'idle' 은 여기에 들지 않는다: 폴더 신뢰 창 같은 선택 창이 떠 있을 수 있다.
   */
  private readonly confirmedIdle = new Set<string>();
  private delivery?: DeliveryService;
  /** 지우는 중인 워크스페이스. 이때는 에이전트를 띄우거나 깨우지 않는다 */
  private readonly removing = new Set<string>();
  /** 에이전트가 이름을 마지막으로 바꾼 때 */
  private readonly renamedAt = new Map<string, number>();
  /** 두레가 방금 프롬프트를 넣은 워크스페이스. 다음 UserPromptSubmit 은 사용자 입력이 아니다 */
  private readonly synthetic = new Set<string>();
  /** 마지막으로 hook 을 받은 시각 */
  private readonly lastActivity = new Map<string, number>();

  private chat?: ChatService;
  /** 폴더 신뢰 창을 지켜보는 중인 워크스페이스 → 그만두는 함수 */
  private readonly trustWatchers = new Map<string, () => void>();

  private engine?: ChatEngine;
  /** 두레가 직접 끄는 중인 채팅 방식 에이전트. 끝난 뒤에 저절로 다시 띄우지 않는다 */
  private readonly stopping = new Set<string>();
  /** 코어를 닫았다. 이후에는 에이전트를 띄우지 않는다 */
  private detached = false;
  /** 채팅 방식으로 띄운 에이전트: 언제 띄웠고 지난 대화를 이어 띄웠는가 (이어가기에 실패하면 새 대화로 다시 띄운다) */
  private readonly chatStarts = new Map<string, { at: number; resumed: boolean; size: { cols: number; rows: number } }>();

  /** 채팅 방식의 에이전트를 돌리는 엔진을 이어 준다. */
  attachEngine(engine: ChatEngine): void {
    this.engine = engine;
  }

  private settings(): Settings {
    return this.d.settings?.() ?? DEFAULT_SETTINGS;
  }

  /** 에이전트 실행 파일. 설정에 경로가 있으면 그것(실행할 수 있어야 한다), 없으면 PATH 에서 찾는다. */
  private agentExecutable(kind: AgentKind, settings: Settings): string {
    const custom = kind === 'claude' ? settings.claudePath : settings.codexPath;
    if (custom) {
      const full = expandHome(custom);
      try {
        accessSync(full, constants.X_OK);
        if (statSync(full).isFile()) return full;
      } catch { /* 아래에서 알린다 */ }
      throw new Error(`설정에 적힌 실행 파일을 쓸 수 없습니다: ${custom}`);
    }
    const found = findExecutable(kind === 'claude' ? 'claude' : 'codex', this.d.baseEnv.PATH);
    if (!found) throw new AgentNotInstalledError(kind);
    return found;
  }

  /** Claude Code 에게 모델 목록을 물어 온다 (설정 화면용). 워크스페이스와 무관하게 잠깐 띄웠다 끈다. */
  async loadModels(): Promise<ModelChoice[]> {
    if (!this.engine) return [];
    if (this.detached) return this.engine.models();
    const executable = this.agentExecutable('claude', this.settings());
    mkdirSync(this.d.dataDir, { recursive: true });
    return this.engine.probeModels({ command: executable, args: [...HEADLESS_ARGS], cwd: this.d.dataDir, env: { ...this.d.baseEnv } });
  }

  /** 에이전트가 살아 있는가 (터미널 방식이든 채팅 방식이든). */
  isAgentRunning(id: string): boolean {
    return this.engine?.has(id) === true || this.d.pty.list(id).some((t) => t.kind === 'agent');
  }

  /** 채팅 방식의 에이전트가 승인이나 답을 기다린다 / 답을 받아 다시 일한다. */
  noteWaiting(id: string, waiting: boolean): void {
    const ws = this.d.workspaces.get(id);
    if (!ws || ws.status === 'stopped') return;
    this.confirmedIdle.delete(id);
    this.lastActivity.set(id, Date.now());
    const next = waiting ? 'waiting_user' : 'working';
    if (ws.status === next) return;
    this.d.workspaces.update(id, { status: next });
    this.emit('changed', id);
  }

  /** 채팅 방식의 에이전트 프로세스가 끝났다. */
  noteSessionExit(id: string, code: number | null, stderr: string): void {
    const start = this.chatStarts.get(id);
    this.chatStarts.delete(id);
    this.agentEnded(id);
    const stoppedByUs = this.stopping.delete(id);
    // 이어갈 대화가 사라졌으면(기록 파일이 지워짐 등) 곧바로 끝난다. 새 대화로 한 번 다시 띄운다.
    // 두레가 직접 끈 것(끄기, 지우기, 앱 닫기)이나 다른 오류(로그인 만료 등)로 끝난 것은 여기에 들지 않는다.
    const lostConversation = typeof code === 'number' && code !== 0 && /no conversation found/i.test(stderr);
    if (start?.resumed && lostConversation && !stoppedByUs && !this.detached && Date.now() - start.at < 10_000 && this.d.workspaces.get(id) && !this.removing.has(id)) {
      this.d.workspaces.setSessionId(id, null);
      this.startAgent(id, start.size).catch(() => undefined);
      return;
    }
    if (code !== 0 && code !== null && stderr.trim() && this.d.workspaces.get(id)) this.lastExit.set(id, stderr.trim().split('\n').slice(-3).join('\n'));
  }

  /** 채팅 방식의 에이전트가 마지막으로 끝날 때 남긴 오류 글. 화면이 이유를 보여주는 데 쓴다. 다시 시작하면 지워진다 */
  exitError(id: string): string | undefined {
    return this.lastExit.get(id);
  }

  private readonly lastExit = new Map<string, string>();

  /** 완료 처리하는 중인 프로젝트. 그동안은 에이전트를 띄우지 않는다 (끄고 지우는 사이에 다시 뜨면 안 된다) */
  private readonly completing = new Set<string>();

  setCompleting(projectId: string, on: boolean): void {
    if (on) this.completing.add(projectId); else this.completing.delete(projectId);
  }

  /** 완료됐거나 완료 처리하는 중인 프로젝트인가. 그런 프로젝트에서는 만들거나 띄우거나 전달하지 않는다. */
  isProjectClosed(projectId: string): boolean {
    return this.completing.has(projectId) || this.d.projects.get(projectId)?.status === 'done';
  }

  /** 에이전트와 그 워크스페이스의 터미널을 모두 끄고 끝날 때까지 기다린다 (프로젝트 완료 처리). */
  async stopAndWait(id: string): Promise<void> {
    await this.killTerminals(id);
  }

  /** 에이전트를 끈다 (터미널 방식이든 채팅 방식이든). */
  stopAgent(id: string): void {
    if (this.engine?.has(id)) this.stopping.add(id);
    this.engine?.stop(id);
    for (const t of this.d.pty.list(id)) if (t.kind === 'agent') this.d.pty.kill(t.id);
  }

  /** 에이전트를 돌리는 방식을 바꾼다. 꺼져 있을 때만 된다. */
  setEngine(id: string, engine: 'chat' | 'terminal'): void {
    const ws = this.mustGet(id);
    if (engine !== 'chat' && engine !== 'terminal') throw new Error('알 수 없는 방식입니다.');
    this.mustBeWorker(ws, '방식을 바꿀');
    if (engine === 'chat' && ws.agentKind !== 'claude') throw new Error('채팅 방식은 Claude Code 만 지원합니다.');
    if (this.isAgentRunning(id)) throw new Error('에이전트를 끈 뒤에 바꿀 수 있습니다.');
    this.d.workspaces.update(id, { engine });
    this.emit('changed', id);
  }

  /** 이름으로 쓸 수 있는 글로 다듬고 확인한다. */
  private cleanName(ws: Workspace, raw: unknown): string {
    // eslint-disable-next-line no-control-regex
    const name = String(raw ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) throw new Error('이름이 비어 있습니다.');
    if (name === COORDINATOR_NAME) throw new Error(`"${COORDINATOR_NAME}" 은 조율 에이전트의 이름이라 쓸 수 없습니다.`);
    // 이름은 에이전트끼리 서로를 가리키는 데 쓴다: 바꾼 이름이 다른 워크스페이스와 같으면 메시지를 보낼 수 없게 된다.
    if (this.d.workspaces.list(ws.projectId).some((w) => w.id !== ws.id && w.name === name)) throw new Error(`이미 있는 워크스페이스 이름입니다: ${name}`);
    return name;
  }

  /**
   * 사용자가 워크스페이스의 표시 이름을 바꾼다. 직접 지은 이름은 고정된다 (에이전트가 바꾸지 못한다).
   * 바뀌는 것은 표시 이름뿐이다. 브랜치와 작업 폴더는 그대로다.
   */
  rename(id: string, raw: string): Workspace {
    const ws = this.mustGet(id);
    this.mustBeWorker(ws, '이름을 바꿀');
    if (this.isProjectClosed(ws.projectId)) throw new Error(DONE_PROJECT);
    const name = this.cleanName(ws, raw);
    this.d.workspaces.update(id, { name, nameLocked: true });
    this.emit('changed', id);
    return this.mustGet(id);
  }

  /** 에이전트가 이름을 바꿔도 되는지를 사용자가 정한다. */
  setAutoName(id: string, on: boolean): Workspace {
    const ws = this.mustGet(id);
    this.mustBeWorker(ws, '이름을 바꿀');
    this.d.workspaces.update(id, { nameLocked: !on });
    this.emit('changed', id);
    return this.mustGet(id);
  }

  /**
   * 에이전트가 자기 워크스페이스의 한 줄 요약과 표시 이름을 갱신한다.
   * 이름은 사용자가 직접 짓지 않은 것만 바꿀 수 있고, 너무 자주 바꾸지 못한다 (화면의 이름이 계속 바뀌면 사용자가 찾지 못한다).
   * 돌려주는 값: 실제로 반영된 것과, 반영하지 않은 이유.
   */
  describeByAgent(id: string, patch: { summary?: unknown; name?: unknown }): { summary?: string; name?: string; note?: string } {
    const ws = this.mustGet(id);
    this.mustBeWorker(ws, '요약과 이름을 바꿀');
    if (this.isProjectClosed(ws.projectId)) throw new Error('완료된 프로젝트다.');
    const out: { summary?: string; name?: string; note?: string } = {};
    if (patch.summary !== undefined) {
      // eslint-disable-next-line no-control-regex
      const summary = String(patch.summary ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_SUMMARY);
      this.d.workspaces.update(id, { summary });
      out.summary = summary;
    }
    if (patch.name !== undefined) {
      const last = this.renamedAt.get(id) ?? 0;
      if (ws.nameLocked) out.note = '이름은 바꾸지 않았다: 사용자가 직접 지은 이름이다.';
      else if (Date.now() - last < RENAME_GAP_MS) out.note = '이름은 바꾸지 않았다: 방금 바꿨다. 이름은 작업의 큰 방향이 바뀔 때만 바꿔라.';
      else {
        try {
          const name = this.cleanName(ws, patch.name);
          if (name !== ws.name) { this.d.workspaces.update(id, { name }); this.renamedAt.set(id, Date.now()); }
          out.name = name;
        } catch (e) {
          out.note = `이름은 바꾸지 않았다: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    if (out.summary !== undefined || out.name !== undefined) this.emit('changed', id);
    return out;
  }

  /** 대화 서비스를 이어 준다: 승인 창 상태를 묻고, 중단·종료·삭제를 알린다. */
  attachChat(chat: ChatService): void {
    this.chat = chat;
  }

  /** 전달 엔진은 이 서비스를 쓰므로 만든 뒤에 이어 준다. */
  attachDelivery(delivery: DeliveryService): void {
    this.delivery = delivery;
  }

  isConfirmedIdle(id: string): boolean {
    // 채팅 방식은 글을 메시지로 보내므로 선택 창에 들어갈 걱정이 없다. 살아 있고, 쉬는 중이고, 묻는 것이 없으면 된다.
    if (this.engine?.has(id)) return this.d.workspaces.get(id)?.status === 'idle' && !this.engine.hasPending(id);
    return this.confirmedIdle.has(id);
  }

  isRemoving(id: string): boolean {
    return this.removing.has(id);
  }

  lastActivityAt(id: string): number | undefined {
    return this.lastActivity.get(id);
  }

  /**
   * 방금 온 UserPromptSubmit 이 두레가 넣은 프롬프트 때문인가. 한 번 물으면 표시가 지워진다.
   * 프롬프트 글로는 가릴 수 없다: 붙여 넣은 글은 <pasted_content> 로 감싸여 온다 (실험 13).
   */
  consumeSynthetic(id: string): boolean {
    return this.synthetic.delete(id);
  }

  /**
   * 사용자가 터미널에 무언가를 입력했다. 에이전트 터미널이면 쉬는 중 확인을 지운다:
   * 입력창에 글을 치는 중이거나 선택 창을 열어 둔 터미널에 두레가 글을 써 넣으면 안 된다.
   */
  noteTerminalInput(terminalId: string): void {
    const workspaceId = this.agentTerminals.get(terminalId);
    if (!workspaceId) return;
    this.confirmedIdle.delete(workspaceId);
    this.trustWatchers.get(workspaceId)?.(); // 사용자가 직접 답하고 있다
    this.chat?.noteTerminalInput(workspaceId);
  }

  private readonly onTerminalExit = (terminalId: string): void => {
    const workspaceId = this.agentTerminals.get(terminalId);
    if (!workspaceId) return;
    this.agentTerminals.delete(terminalId);
    this.agentEnded(workspaceId);
  };

  /** 에이전트가 끝난 뒤의 정리 (두 방식 공통). */
  private agentEnded(workspaceId: string): void {
    this.trustWatchers.get(workspaceId)?.();
    this.confirmedIdle.delete(workspaceId);
    this.synthetic.delete(workspaceId);
    this.lastActivity.delete(workspaceId);
    // 첫 프롬프트를 받기 전에 끝났다면 건넨 메시지를 되돌린다.
    this.delivery?.agentExited(workspaceId);
    this.chat?.agentExited(workspaceId);
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
    this.detached = true;
    for (const stop of [...this.trustWatchers.values()]) stop();
    this.d.pty.off('exit', this.onTerminalExit);
  }

  /** 워크스페이스의 터미널을 모두 끄고 실제로 끝날 때까지 (최대 3초) 기다린다. */
  /** 여러 선택지 질문에 답한다 (채팅 방식). */
  answerQuestion(id: string, requestId: string, answers: Record<string, string>): void {
    if (!this.engine?.has(id)) throw new Error('질문을 기다리는 중이 아닙니다.');
    this.engine.answerQuestion(id, String(requestId ?? ''), answers);
  }

  dismissQuestion(id: string, requestId: string): void {
    if (!this.engine?.has(id)) throw new Error('질문을 기다리는 중이 아닙니다.');
    this.engine.dismissQuestion(id, String(requestId ?? ''));
  }

  /**
   * 채팅 방식에서 승인·질문 대기는 엔진이 안다. hook 이 상태를 바꾼 뒤에 엔진의 대기에 맞춘다:
   * 대기 중에 다른 호출의 hook 이 와서 '작업 중' 이 되면 승인 카드가 사라지고, 에이전트는 계속 기다리게 된다.
   */
  reconcileWaiting(id: string): void {
    if (!this.engine?.has(id)) return;
    const ws = this.d.workspaces.get(id);
    if (!ws || ws.status === 'stopped') return;
    const waiting = this.engine.hasPending(id);
    if (waiting && ws.status !== 'waiting_user') this.noteWaiting(id, true);
    else if (!waiting && ws.status === 'waiting_user') this.noteWaiting(id, false);
  }

  /**
   * 채팅 방식의 에이전트가 한 차례를 끝냈다. 아직 '작업 중' 이면 Stop hook 이 오지 않은 것이다(멈춤, 오류): 쉬는 중으로 되돌린다.
   */
  noteTurnEnd(id: string): void {
    const ws = this.d.workspaces.get(id);
    if (!ws || ws.status === 'stopped') return;
    this.lastActivity.set(id, Date.now());
    if (ws.status === 'working' || ws.status === 'waiting_user') {
      this.d.workspaces.update(id, { status: 'idle' });
      this.emit('changed', id);
    }
  }

  private async killTerminals(workspaceId: string): Promise<void> {
    if (this.engine?.has(workspaceId)) this.stopping.add(workspaceId);
    this.engine?.stop(workspaceId);
    for (let i = 0; i < 100 && this.engine?.has(workspaceId); i++) await new Promise((r) => setTimeout(r, 30));
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

  /** 조율 에이전트에게는 할 수 없는 일을 막는다 (화면에서는 닿지 않지만 IPC 로는 부를 수 있다). */
  private mustBeWorker(ws: Workspace, what: string): void {
    if (ws.role === 'coordinator') throw new Error(`조율 에이전트에는 ${what} 수 없습니다.`);
  }

  async create(i: CreateWorkspaceInput): Promise<Workspace> {
    const project = this.d.projects.get(i.projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${i.projectId}`);
    if (this.isProjectClosed(project.id)) throw new Error(DONE_PROJECT);
    const repo = this.d.repos.get(i.repoId);
    if (!repo || repo.projectId !== project.id) throw new Error(`이 프로젝트에 등록된 저장소가 아닙니다: ${i.repoId}`);

    const typed = i.name?.trim();
    // 이름은 에이전트끼리 서로를 가리키는 데 쓴다: 조율 에이전트의 이름은 쓸 수 없다 (조율인 척하는 워크스페이스가 생기지 않게).
    if (typed === COORDINATOR_NAME) throw new Error(`"${COORDINATOR_NAME}" 은 조율 에이전트의 이름이라 쓸 수 없습니다.`);
    const name = typed || `${repo.name}-${this.d.workspaces.list(project.id).length + 1}`;
    const settings = this.settings();
    // 작업 폴더 위치: 설정에 있으면 그곳, 없으면 기본 위치. 이미 만든 워크스페이스는 옮기지 않는다.
    const projectDir = join(settings.worktreeRoot ? expandHome(settings.worktreeRoot) : this.d.worktreeRoot, slugify(project.name));
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
        permissionMode: i.permissionMode ?? settings.defaultPermissionMode, engine: i.engine ?? settings.defaultEngine, token: randomBytes(32).toString('hex'),
      });
      this.emit('changed', ws.id);
      return ws;
    } catch (e) {
      await undo();
      throw e;
    }
  }

  async remove(id: string, o: { deleteWorktree: boolean; withCoordinator?: boolean }): Promise<void> {
    const ws = this.mustGet(id);
    // 조율 에이전트는 프로젝트를 지울 때만 같이 지운다.
    if (!o.withCoordinator) this.mustBeWorker(ws, '지울');
    // 지우는 동안 메시지가 와도 이 워크스페이스에 에이전트를 띄우지 않게 한다.
    this.removing.add(id);
    try {
      await this.removeInner(ws, o);
    } finally {
      this.removing.delete(id);
      this.delivery?.forget(id);
      this.chat?.forget(id);
    }
  }

  /** 방금 만든 워크스페이스를 없던 것으로 한다: 작업 폴더와 브랜치까지 지운다. 계획안 승인 도중 실패했을 때 쓴다. */
  async discard(id: string): Promise<void> {
    const ws = this.mustGet(id);
    const repo = this.d.repos.get(ws.repoId);
    await this.remove(id, { deleteWorktree: true });
    if (repo && ws.branch && await this.d.git.branchExists(repo.path, ws.branch)) await this.d.git.deleteBranch(repo.path, ws.branch);
  }

  private async removeInner(ws: Workspace, o: { deleteWorktree: boolean }): Promise<void> {
    const id = ws.id;
    // 작업 폴더를 지우기 전에 그 안에서 도는 프로세스를 먼저 끝낸다.
    await this.killTerminals(id);
    if (o.deleteWorktree && ws.role !== 'coordinator') {
      const repo = this.d.repos.get(ws.repoId);
      if (repo) await this.d.git.removeWorktree({ repoPath: repo.path, worktreePath: ws.worktreePath });
    }
    this.d.pty.forgetExited(id);
    this.d.todos.removeWorkspace(id);
    this.d.messages.removeWorkspace(id, ws.name);
    this.confirmedIdle.delete(id);
    this.d.workspaces.remove(id);
    rmSync(this.configDir(id), { recursive: true, force: true });
    this.emit('changed', id);
  }

  /** 에이전트를 띄운다. 터미널 방식이면 그 터미널을, 채팅 방식이면 null 을 돌려준다. */
  async startAgent(id: string, size: { cols: number; rows: number }, initialPrompt?: string): Promise<TerminalInfo | null> {
    const ws = this.mustGet(id);
    const running = this.d.pty.list(id).find((t) => t.kind === 'agent');
    if (running) return running;
    // 방금 끈 에이전트가 아직 끝나는 중이면 끝날 때까지 기다린다 (살아 있다고 보고 돌아가면 곧 꺼진다).
    for (let i = 0; i < 100 && this.stopping.has(id) && this.engine?.has(id); i++) await new Promise((r) => setTimeout(r, 30));
    if (this.engine?.has(id)) return null;
    if (this.detached) throw new Error('두레를 닫는 중입니다.');
    const headless = ws.engine === 'chat' && ws.agentKind === 'claude' && this.engine !== undefined;
    const resumeSessionId = headless ? this.d.workspaces.getSessionId(id) : undefined;
    if (this.removing.has(id)) throw new Error('지우는 중인 워크스페이스입니다.');
    this.d.pty.forgetExited(id, 'agent'); // 지난 에이전트 탭 기록은 치운다
    const coordinator = ws.role === 'coordinator';
    // 조율 에이전트의 폴더는 두레가 관리한다. 없으면 만든다.
    if (coordinator) mkdirSync(ws.worktreePath, { recursive: true });
    if (!existsSync(ws.worktreePath)) throw new WorktreeMissingError(ws.worktreePath);

    const project = this.d.projects.get(ws.projectId)!;
    if (this.isProjectClosed(project.id)) throw new Error(DONE_PROJECT);
    const settings = this.settings();
    const executable = this.agentExecutable(ws.agentKind, settings);
    // 저장된 뒤에 규칙이 바뀌었을 수도 있으니 쓰기 직전에 한 번 더 거른다.
    const extraArgs = parseArgs(ws.agentKind === 'claude' ? settings.claudeArgs : settings.codexArgs);
    const reserved = reservedArg(ws.agentKind, extraArgs);
    if (reserved) throw new Error(`설정의 추가 인자에 쓸 수 없는 것이 있습니다: ${reserved}`);
    // 받은 메시지가 기다리고 있으면 그것을 첫 프롬프트로 준다. 실행 파일을 확인한 뒤에 가져가야 실패 시 사라지지 않는다.
    // 이 저장소에 대한 커밋·push 만 막기 위해 저장소의 공용 .git 폴더를 알아 둔다. 못 알아내면 막는 장치 없이 띄운다.
    const realGit = findExecutable('git', this.d.baseEnv.PATH);
    // 조율 에이전트의 폴더는 저장소가 아니지만 등록된 저장소를 읽을 수 있다: 그 저장소 전부에 대한 commit·push 를 막는다.
    const repoPaths = coordinator ? this.d.repos.list(ws.projectId).map((r) => r.path).filter((p) => existsSync(p)) : [];
    const gitCommonDir = !realGit ? [] : (await Promise.all((coordinator ? repoPaths : [ws.worktreePath]).map((p) => this.d.git.commonDir(p).catch(() => undefined)))).filter((c): c is string => Boolean(c));
    // 기다리는 사이에 지워지거나 닫혔으면 띄우지 않는다.
    if (this.removing.has(id) || this.detached || !this.d.workspaces.get(id)) throw new Error('지우는 중인 워크스페이스입니다.');
    if (this.isProjectClosed(ws.projectId)) throw new Error(DONE_PROJECT);
    if (this.engine?.has(id)) return null;
    const firstPrompt = initialPrompt ?? this.delivery?.takeForStart(id);
    const launch = buildAgentLaunch({
      kind: ws.agentKind,
      permissionMode: ws.permissionMode,
      mcpUrl: this.d.mcpUrl,
      hookUrl: this.d.hookUrl,
      realGit,
      gitCommonDir,
      basePath: this.d.baseEnv.PATH ?? '',
      token: this.d.workspaces.getToken(id),
      configDir: this.configDir(id),
      instructions: coordinator ? coordinatorInstructions(project) : baseInstructions(ws, project),
      // 조율 에이전트는 코드를 고치지 않는다: 파일을 고치는 도구를 빼고, 등록된 저장소는 읽을 수 있게 한다.
      disallowedTools: coordinator ? ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : undefined,
      addDirs: coordinator ? repoPaths : undefined,
      // 조율 에이전트는 사용자의 원본 저장소에 닿는다: 파일을 바꾸는 셸 명령(rm, mv, sed 등)도 하나하나 승인을 받게 한다.
      manualEdits: coordinator,
      initialPrompt: firstPrompt,
      headless,
      resumeSessionId,
      model: settings.claudeModel || undefined,
      effort: settings.claudeEffort || undefined,
      extraArgs,
    });

    let terminal: TerminalInfo | null = null;
    try {
      for (const f of launch.files) {
        mkdirSync(dirname(f.path), { recursive: true });
        const mode = f.mode ?? 0o600; // 토큰이 들어 있다
        writeFileSync(f.path, f.content, { mode });
        chmodSync(f.path, mode); // 이미 있던 파일은 writeFileSync 가 권한을 바꾸지 않는다
      }
      if (headless) {
        // 채팅 방식: 터미널 화면 없이 띄운다. 폴더 신뢰 창이 없고(실험 17), 프롬프트는 표준 입력으로 보낸다.
        this.chatStarts.set(id, { at: Date.now(), resumed: Boolean(resumeSessionId), size });
        this.lastExit.delete(id);
        this.engine!.start(id, { command: executable, args: launch.args, cwd: ws.worktreePath, env: { ...this.d.baseEnv, ...launch.env } });
        if (firstPrompt) this.engine!.say(id, firstPrompt);
      } else terminal = this.d.pty.spawn({
        workspaceId: id, kind: 'agent', title: AGENT_NAMES[ws.agentKind],
        command: executable, args: launch.args, cwd: ws.worktreePath,
        env: { ...this.d.baseEnv, ...launch.env }, cols: size.cols, rows: size.rows,
      });
    } catch (e) {
      this.delivery?.startFailed(id); // 첫 프롬프트로 가져간 메시지를 되돌린다
      throw e;
    }
    // 첫 프롬프트는 두레가 넣은 것이다: 사용자 개입으로 세지 않는다.
    if (firstPrompt) this.synthetic.add(id);
    this.lastActivity.set(id, Date.now());
    if (terminal) this.agentTerminals.set(terminal.id, id);
    // 새 대화는 이전 목록을 본 적이 없다. 꺼져 있던 동안의 변경 기록은 버리고, 목록은 에이전트가 todo_list 로 읽는다.
    this.d.todos.takePending(id);
    if (ws.agentKind === 'claude' && terminal && settings.autoTrust) this.answerTrustPrompt(id, terminal.id, ws.worktreePath);
    // Claude Code 는 첫 hook 이 올 때까지 '시작 중' 이다: 폴더 신뢰 창이 떠 있을 수 있다 (실험 12: 그동안은 hook 이 오지 않는다).
    // Codex 는 hook 이 없어 알 길이 없으므로 예전처럼 쉬는 중으로 둔다.
    this.d.workspaces.update(id, { status: ws.agentKind === 'claude' ? 'starting' : 'idle' });
    this.emit('changed', id);
    return terminal;
  }

  /**
   * Claude Code 가 처음 보는 폴더에서 묻는 "이 폴더를 신뢰하는가" 창에 두레가 대신 "신뢰함" 으로 답한다. [사용자 결정, 2026-11-11]
   * 작업 폴더는 사용자가 직접 등록한 저장소에서 두레가 만든 것이다.
   * 화면이 그 창이고, 묻는 폴더가 이 작업 폴더이고, 커서가 "Yes" 에 있는 것을 확인한 뒤에만 Enter 를 보낸다.
   * 조금이라도 다르면 아무것도 누르지 않는다: 사용자가 터미널에서 직접 답하면 된다.
   */
  private answerTrustPrompt(workspaceId: string, terminalId: string, worktreePath: string): void {
    let folders = [worktreePath];
    try { folders = [...new Set([worktreePath, realpathSync(worktreePath)])]; } catch { /* 경로 그대로 쓴다 */ }
    let moves = 0;
    let timer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (timer) clearTimeout(timer);
      clearTimeout(giveUp);
      this.d.pty.off('data', onData);
      this.trustWatchers.delete(workspaceId);
    };
    const check = (): void => {
      const live = this.d.pty.list(workspaceId).some((t) => t.id === terminalId);
      // 첫 hook 이 왔다면 신뢰 창은 이미 지나갔다 (실험 12).
      if (!live || this.d.workspaces.get(workspaceId)?.status !== 'starting') { stop(); return; }
      const state = trustPrompt(this.d.pty.buffer(terminalId).slice(-4000), folders);
      if (state === 'on-yes') {
        this.d.pty.write(terminalId, '\r');
        stop();
      } else if (state === 'on-no' && moves < 3) {
        moves++;
        this.d.pty.write(terminalId, '\x1b[B'); // 아래로 한 칸. 화면이 다시 그려지면 다시 확인한다
      } else if (state === 'on-no') {
        stop();
      }
    };
    // 화면이 다 그려진 뒤에 본다: 출력이 잠잠해지면 확인한다.
    const onData = (id: string): void => {
      if (id !== terminalId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 500);
      timer.unref();
    };
    const giveUp = setTimeout(stop, 30_000);
    giveUp.unref();
    this.trustWatchers.get(workspaceId)?.();
    this.trustWatchers.set(workspaceId, stop);
    this.d.pty.on('data', onData);
  }

  /**
   * 쉬는 에이전트에게 미전달 TODO 변경을 바로 알릴 수 있는가.
   * 터미널에 글을 써 넣는 방식이라, hook 신호로 쉬는 중임이 확인된 Claude Code 에서만 허용한다.
   * (선택 창이 떠 있을 수 있는 터미널에 써 넣으면 의도하지 않은 동작이 실행된다.)
   */
  /** hook 이 올 때마다 부른다. 응답을 그냥 끝낸 Stop 만 쉬는 중의 근거가 된다. */
  noteHook(id: string, event: string, blocked: boolean): void {
    this.lastActivity.set(id, Date.now());
    if (event === 'Stop' && !blocked) this.confirmedIdle.add(id);
    else this.confirmedIdle.delete(id);
  }

  /** 사용자가 "지금 알리기" 를 누를 수 있는가: 전달할 것이 있고 에이전트가 쉬는 중임이 확인됐다. */
  canNudge(id: string): boolean {
    return this.delivery?.state(id) === 'waking';
  }

  /** 미전달 TODO 변경과 메시지를 쉬는 에이전트에게 지금 전달한다. */
  async nudge(id: string): Promise<void> {
    if (!this.delivery || !this.canNudge(id)) throw new Error('에이전트가 쉬는 중일 때만 알릴 수 있습니다.');
    await this.delivery.kick(id);
  }

  /**
   * 쉬는 에이전트의 터미널에 글을 써 넣어 깨운다.
   * hook 으로 쉬는 중임이 확인된 Claude Code 에서만 한다: 선택 창이 떠 있을 수 있는 터미널에 써 넣으면
   * 의도하지 않은 동작이 실행된다.
   */
  async wake(id: string, text: string): Promise<void> {
    const ws = this.d.workspaces.get(id);
    if (ws && this.engine?.has(id)) {
      // 채팅 방식: 터미널에 써 넣지 않고 메시지로 보낸다. 쉬는 중일 때만 한다 (작업 중에는 hook 응답에 실린다).
      if (!this.isConfirmedIdle(id) || this.removing.has(id)) throw new Error('에이전트가 쉬는 중일 때만 알릴 수 있습니다.');
      this.confirmedIdle.delete(id);
      this.synthetic.add(id); // 이 프롬프트는 두레가 넣는 것이다
      this.lastActivity.set(id, Date.now());
      this.d.workspaces.update(id, { status: 'working' });
      this.emit('changed', id);
      try { this.engine.say(id, text); } catch (e) { this.synthetic.delete(id); throw e; }
      return;
    }
    const terminal = this.d.pty.list(id).find((t) => t.kind === 'agent');
    if (!ws || ws.agentKind !== 'claude' || ws.status !== 'idle' || !this.confirmedIdle.has(id) || !terminal || this.removing.has(id)) {
      throw new Error('에이전트가 쉬는 중일 때만 알릴 수 있습니다.');
    }
    // 본문의 제어 문자는 저장할 때 걸러지지만, 터미널에 쓰는 글은 여기서 한 번 더 거른다.
    // eslint-disable-next-line no-control-regex
    const message = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    // 쓰기 전에 상태를 바꿔 같은 내용을 두 번 보내지 못하게 한다.
    this.confirmedIdle.delete(id);
    this.synthetic.add(id); // 이 프롬프트는 두레가 넣는 것이다
    this.lastActivity.set(id, Date.now());
    this.d.workspaces.update(id, { status: 'working' });
    this.emit('changed', id);
    // 여러 줄은 붙여넣기로 묶어 넣고, 잠시 뒤 Enter 를 따로 보낸다 (실험 03, 12b).
    this.d.pty.write(terminal.id, `\x1b[200~${message}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 400));
    if (!this.d.pty.list(id).some((t) => t.id === terminal.id)) {
      this.synthetic.delete(id);
      throw new Error('에이전트가 종료되어 전달하지 못했습니다.');
    }
    this.d.pty.write(terminal.id, '\r');
  }

  /**
   * 작업 중인 에이전트를 멈춘다 (프로세스는 살려 둔다).
   * Esc 로 중단하면 아무 hook 도 오지 않으므로(실험 12c) 상태는 여기서 바꾼다. 쉬는 중으로 확인된 것은 아니다.
   */
  interrupt(id: string): void {
    const ws = this.d.workspaces.get(id);
    if (ws && this.engine?.has(id)) {
      if (ws.status !== 'working' && ws.status !== 'waiting_user') return;
      this.engine.interrupt(id).catch(() => undefined);
      this.confirmedIdle.delete(id);
      this.d.workspaces.update(id, { status: 'idle' });
      this.chat?.interrupted(id);
      this.emit('changed', id);
      return;
    }
    const terminal = this.d.pty.list(id).find((t) => t.kind === 'agent');
    if (!ws || !terminal || ws.agentKind !== 'claude' || (ws.status !== 'working' && ws.status !== 'waiting_user')) return;
    this.d.pty.write(terminal.id, '\x1b');
    this.confirmedIdle.delete(id);
    this.d.workspaces.update(id, { status: 'idle' });
    this.chat?.interrupted(id);
    this.emit('changed', id);
  }

  /**
   * 대화 기록에서 "사용자가 중단함" 을 읽었다. 터미널에서 직접 Esc 를 눌렀거나 승인을 거부한 경우다.
   * 그때는 hook 이 오지 않아(실험 12c, 15e) 상태가 '작업 중'/'승인 대기' 에 머문다. 쉬는 중으로 되돌린다.
   * 쉬는 중으로 확인된 것은 아니다: 두레가 스스로 글을 써 넣는 근거로는 쓰지 않는다.
   */
  noteInterrupted(id: string): void {
    const ws = this.d.workspaces.get(id);
    if (!ws || (ws.status !== 'working' && ws.status !== 'waiting_user')) return;
    this.confirmedIdle.delete(id);
    this.d.workspaces.update(id, { status: 'idle' });
    this.emit('changed', id);
  }

  /**
   * 채팅 입력창의 글을 지금 에이전트에게 보낼 수 있는가.
   * 쉬는 중이면 터미널에 써 넣고, 작업 중이면 두레가 맡아 두었다가 다음 hook 응답에 실어 전달한다.
   * 시작 중(폴더 신뢰 창)이나 승인 대기 중에는 받지 않는다.
   */
  canSendInput(id: string): boolean {
    const ws = this.d.workspaces.get(id);
    if (!ws || ws.agentKind !== 'claude' || this.removing.has(id)) return false;
    // 채팅 방식은 글을 메시지로 보내므로 언제든 받는다 (작업 중이면 에이전트가 같은 차례 안에 읽는다, 실험 18).
    if (this.engine?.has(id)) return ws.status !== 'stopped';
    if (ws.status !== 'idle' && ws.status !== 'working') return false;
    return this.d.pty.list(id).some((t) => t.kind === 'agent');
  }

  /** 사용자가 채팅 입력창에서 보낸 글을 에이전트의 터미널에 써 넣는다. */
  async sendUserInput(id: string, text: string): Promise<void> {
    // eslint-disable-next-line no-control-regex
    const message = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim();
    if (!message) throw new Error('보낼 글을 입력하세요.');
    const owner = this.d.workspaces.get(id);
    if (owner && this.isProjectClosed(owner.projectId)) throw new Error(DONE_PROJECT);
    if (this.engine?.has(id)) {
      if (!this.canSendInput(id)) throw new Error('지금은 보낼 수 없습니다.');
      // 사용자의 입력이다: 두레가 넣은 프롬프트로 치지 않고, 쉬는 중 확인을 지운다.
      this.confirmedIdle.delete(id);
      this.synthetic.delete(id);
      const wsNow = this.d.workspaces.get(id);
      // 작업 중에 보낸 글은 UserPromptSubmit 을 부르지 않을 수 있다. 사용자가 끼어든 것으로 센다.
      if (wsNow && wsNow.status !== 'idle') this.d.messages.userIntervened(wsNow.projectId);
      this.engine.say(id, message);
      this.chat?.refreshSoon(id, [300, 1200, 3000]);
      return;
    }
    const terminal = this.d.pty.list(id).find((t) => t.kind === 'agent');
    const before = this.d.workspaces.get(id);
    if (!this.canSendInput(id) || !terminal || !before) throw new Error('지금은 채팅으로 보낼 수 없습니다. 터미널을 확인하세요.');
    // 슬래시 명령(/compact, /context 등)은 에이전트의 입력칸에서만 명령으로 실행된다. hook 도 부르지 않는다 (실험 16).
    const slash = /^\/[A-Za-z][\w:-]*(\s|$)/.test(message) && !message.includes('\n');
    if (slash && before.status !== 'idle') throw new Error('슬래시 명령은 에이전트가 쉬는 중일 때만 보낼 수 있습니다.');
    if (slash) {
      this.confirmedIdle.delete(id);
      this.synthetic.delete(id);
      this.d.pty.write(terminal.id, message);
      await new Promise((r) => setTimeout(r, 400));
      if (!this.d.pty.list(id).some((t) => t.id === terminal.id)) throw new Error('에이전트가 종료되어 보내지 못했습니다.');
      this.d.pty.write(terminal.id, '\r');
      // 상태는 쉬는 중 그대로 둔다: 명령이 끝났다는 신호가 오지 않는다. 출력은 기록에서 읽는다.
      this.chat?.refreshSoon(id);
      return;
    }
    if (before.status === 'working') {
      // 작업 중인 터미널에는 쓰지 않는다: 승인 창이 떠 있을 수 있고, 떴다는 알림은 몇 초 늦게 온다 (실험 15e).
      // 그 틈에 글과 Enter 를 써 넣으면 Enter 가 "허용" 으로 들어간다. 두레가 맡아 두었다가 다음 hook 응답에 싣는다.
      if (!this.chat) throw new Error('지금은 채팅으로 보낼 수 없습니다. 터미널을 확인하세요.');
      this.chat.queue(id, message);
      // 사용자가 끼어든 것이다: 에이전트끼리의 왕복 횟수를 다시 센다 (이 길로는 UserPromptSubmit 이 오지 않는다).
      this.d.messages.userIntervened(before.projectId);
      return;
    }
    // 쉬는 중: 입력칸에 써 넣는다. 사용자의 입력이므로 두레가 넣은 프롬프트로 치지 않고, 쉬는 중 확인을 지운다.
    // 앞서 맡아 두고 전달하지 못한 글(중단 등으로)이 있으면 함께 보낸다.
    const full = [...(this.chat?.takeQueuedTexts(id) ?? []), message].join('\n\n');
    this.confirmedIdle.delete(id);
    this.synthetic.delete(id);
    // 쓰기 전에 상태를 바꿔, 400ms 사이에 다른 것(깨우기, 또 한 번의 보내기)이 같은 입력칸에 쓰지 못하게 한다.
    this.d.workspaces.update(id, { status: 'working' });
    this.emit('changed', id);
    this.d.pty.write(terminal.id, full.includes('\n') ? `\x1b[200~${full}\x1b[201~` : full);
    await new Promise((r) => setTimeout(r, 400));
    if (!this.d.pty.list(id).some((t) => t.id === terminal.id)) throw new Error('에이전트가 종료되어 보내지 못했습니다.');
    this.d.pty.write(terminal.id, '\r');
  }

  /**
   * 채팅의 승인 카드에서 고른 답을 승인 창에 써 넣는다.
   * hook 으로 승인 창임이 확인됐고, 사용자가 터미널에서 그 창을 건드리지 않았을 때만 한다 (실험 15e: 커서는 "1. Yes" 에 있다).
   */
  answerPermission(id: string, answer: 'allow' | 'deny' | 'always', requestId = ''): void {
    if (this.engine?.has(id)) { this.engine.answerPermission(id, String(requestId ?? ''), answer); return; }
    if (answer === 'always') throw new Error('터미널 방식에서는 "앞으로 묻지 않기" 를 터미널에서 고르세요.');
    const ws = this.d.workspaces.get(id);
    const terminal = this.d.pty.list(id).find((t) => t.kind === 'agent');
    if (!ws || !terminal || ws.agentKind !== 'claude' || ws.status !== 'waiting_user' || !this.chat?.hasPendingPermission(id)) {
      throw new Error('승인을 기다리는 중이 아닙니다.');
    }
    if (answer !== 'allow' && answer !== 'deny') throw new Error('알 수 없는 답입니다.');
    this.chat.permissionAnswered(id);
    this.confirmedIdle.delete(id);
    this.d.pty.write(terminal.id, answer === 'allow' ? '\r' : '\x1b');
    // 거부하면 hook 이 오지 않는다. 허용하면 곧 PostToolUse 가 온다.
    this.d.workspaces.update(id, { status: answer === 'allow' ? 'working' : 'idle' });
    this.emit('changed', id);
  }

  /** 작업 폴더에 커밋하지 않은 변경이 몇 건인지. 폴더가 없으면 0. */
  async uncommittedCount(id: string): Promise<number> {
    const ws = this.mustGet(id);
    return existsSync(ws.worktreePath) ? this.d.git.uncommittedCount(ws.worktreePath) : 0;
  }

  async openShell(id: string, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    const ws = this.mustGet(id);
    this.mustBeWorker(ws, '셸을 열');
    if (this.isProjectClosed(ws.projectId)) throw new Error(DONE_PROJECT);
    if (!existsSync(ws.worktreePath)) throw new WorktreeMissingError(ws.worktreePath);
    return this.d.pty.spawn({
      workspaceId: id, kind: 'shell', title: '셸',
      command: this.d.baseEnv.SHELL || '/bin/zsh', args: ['-l'], cwd: ws.worktreePath,
      env: this.d.baseEnv, cols: size.cols, rows: size.rows,
    });
  }
}
