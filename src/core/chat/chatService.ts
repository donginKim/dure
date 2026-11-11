import { EventEmitter } from 'node:events';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ChatItem, ChatPermission, ChatSnapshot } from '@shared/types';
import type { WorkspaceStore } from '../stores';
import { Timeline } from './timeline';
import { parseLine, stepInput, stepSummary, type Piece } from './transcript';

export interface ChatDeps {
  workspaces: WorkspaceStore;
  /** 대화 기록을 읽어도 되는 뿌리 폴더 (보통 ~/.claude). 이 밖의 경로는 읽지 않는다 */
  allowedRoot: string;
  /** 작업 중에 기록을 다시 읽는 간격 (ms). 기본 1000 */
  pollMs?: number;
  /** 기록에서 "사용자가 중단함" 을 읽었다. 중단과 승인 거부 때는 hook 이 오지 않아 상태를 여기서 되돌려야 한다 (실험 12c, 15e) */
  onInterrupted?(workspaceId: string): void;
}

interface State {
  path: string | null;
  /** 다음에 읽을 자리 (바이트) */
  offset: number;
  /** 줄바꿈으로 끝나지 않아 아직 쓰지 못한 끝부분 */
  carry: Buffer;
  timeline: Timeline;
  workingSince: number | null;
  lastTool: { tool: string; input: unknown } | null;
  pendingPermission: ChatPermission | null;
  /** 마지막으로 "일하는 중" 임을 알린 hook 의 시각 */
  lastWorkSignalAt: number;
  error: boolean;
  timers: Set<NodeJS.Timeout>;
}

const MAX_ITEMS = 400;
const READ_CHUNK = 1 << 20;
const CODEX = 'Codex 는 아직 채팅 보기를 지원하지 않습니다. 터미널 보기를 쓰세요.';
const UNREADABLE = '대화 기록을 읽을 수 없습니다. 터미널 보기를 쓰세요.';
// 선택지가 여럿인 창을 띄우는 도구. Enter 가 "허용" 을 뜻하지 않는다.
const NOT_A_YES_NO = new Set(['AskUserQuestion', 'ExitPlanMode']);

const field = (payload: unknown, key: string): unknown =>
  (typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[key] : undefined);

/**
 * 워크스페이스별 대화. Claude Code 가 쓰는 대화 기록 파일을 이어 읽어 채팅 보기의 항목으로 바꾼다.
 * 기록 파일은 읽기만 한다. 이벤트: 'changed' (workspaceId)
 */
export class ChatService extends EventEmitter {
  private readonly states = new Map<string, State>();
  private readonly root: string;
  private poll: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly d: ChatDeps) {
    super();
    let root = resolve(d.allowedRoot);
    try { root = realpathSync(root); } catch { /* 아직 없는 폴더 */ }
    this.root = root;
  }

  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) {
      s = { path: null, offset: 0, carry: Buffer.alloc(0), timeline: new Timeline(), workingSince: null, lastTool: null,
        pendingPermission: null, lastWorkSignalAt: 0, error: false, timers: new Set() };
      this.states.set(id, s);
    }
    return s;
  }

  /** hook 이 알려준 경로가 읽어도 되는 기록 파일인가. 글자로만 본다 (파일이 아직 없을 수 있다). */
  private acceptable(path: unknown): path is string {
    if (typeof path !== 'string' || !path.endsWith('.jsonl')) return false;
    const full = resolve(path);
    return full.startsWith(this.root + sep) || full.startsWith(resolve(this.d.allowedRoot) + sep);
  }

  /**
   * hook 이 올 때마다 부른다. 기록 경로를 알아 두고 새 줄을 읽는다.
   * blocked: 두레가 이 Stop 을 막아 에이전트가 이어서 일한다.
   */
  noteHook(workspaceId: string, event: string, payload: unknown, blocked = false): void {
    if (this.disposed) return;
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws || ws.agentKind !== 'claude') return;
    const s = this.state(workspaceId);
    const before = this.fingerprint(s);

    const path = field(payload, 'transcript_path');
    if (this.acceptable(path)) {
      const full = resolve(path);
      if (full !== s.path) this.reset(s, full); // 새 대화 (다시 시작했거나 /clear)
    }

    const now = Date.now();
    switch (event) {
      case 'UserPromptSubmit':
        s.workingSince ??= now;
        s.lastWorkSignalAt = now;
        s.pendingPermission = null;
        break;
      case 'PreToolUse':
        s.workingSince ??= now;
        s.lastWorkSignalAt = now;
        s.lastTool = { tool: String(field(payload, 'tool_name') ?? ''), input: field(payload, 'tool_input') };
        s.pendingPermission = null;
        break;
      case 'PostToolUse':
        s.lastWorkSignalAt = now;
        s.lastTool = null;
        s.pendingPermission = null;
        break;
      case 'Notification':
        if (field(payload, 'notification_type') === 'permission_prompt') {
          const t = s.lastTool;
          s.pendingPermission = t
            ? { tool: t.tool, summary: stepSummary(t.tool, t.input), input: stepInput(t.tool, t.input), canAnswer: !NOT_A_YES_NO.has(t.tool) }
            : { tool: '', summary: '승인 요청', input: '', canAnswer: false };
        }
        break;
      case 'Stop':
        s.pendingPermission = null;
        s.lastTool = null;
        if (!blocked) s.workingSince = null;
        else s.lastWorkSignalAt = now;
        break;
      case 'SessionStart':
        s.workingSince = null;
        s.pendingPermission = null;
        s.lastTool = null;
        break;
    }

    this.read(workspaceId, s);
    // 기록은 hook 보다 조금 늦게 쓰인다 (실험 15a: 0.5초 안). 뒤따라 두 번 더 읽는다.
    for (const ms of [400, 1500]) this.later(workspaceId, s, ms);
    this.schedule();
    if (this.fingerprint(s) !== before) this.emit('changed', workspaceId);
  }

  private later(workspaceId: string, s: State, ms: number): void {
    const t = setTimeout(() => {
      s.timers.delete(t);
      if (this.states.get(workspaceId) === s) this.readAndEmit(workspaceId, s);
    }, ms);
    t.unref();
    s.timers.add(t);
  }

  private fingerprint(s: State): string {
    return `${s.path}|${s.timeline.version}|${s.workingSince}|${s.pendingPermission ? `${s.pendingPermission.summary}:${s.pendingPermission.canAnswer}` : ''}|${s.error}`;
  }

  private reset(s: State, path: string | null): void {
    s.path = path;
    s.offset = 0;
    s.carry = Buffer.alloc(0);
    s.timeline.reset();
    s.error = false;
  }

  private readAndEmit(workspaceId: string, s: State): void {
    const before = this.fingerprint(s);
    this.read(workspaceId, s);
    if (this.fingerprint(s) !== before) this.emit('changed', workspaceId);
  }

  /** 작업 중인 워크스페이스가 있는 동안만 주기적으로 읽는다 (에이전트의 글은 hook 없이 기록된다). */
  private schedule(): void {
    const active = [...this.states.values()].some((s) => s.workingSince !== null);
    if (active && !this.poll) {
      this.poll = setInterval(() => {
        for (const [id, s] of this.states) if (s.workingSince !== null) this.readAndEmit(id, s);
      }, this.d.pollMs ?? 1000);
      this.poll.unref();
    } else if (!active && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  /** 읽은 자리 뒤의 새 줄을 읽어 대화에 더한다. 던지지 않는다. */
  private read(workspaceId: string, s: State): void {
    if (!s.path) return;
    let fd: number | undefined;
    try {
      try {
        fd = openSync(s.path, 'r');
      } catch (e) {
        // 대화를 막 시작해 아직 파일이 없는 것은 오류가 아니다.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') { s.error = s.offset > 0; return; }
        throw e;
      }
      // 링크를 따라간 실제 위치도 허용된 폴더 안이어야 한다.
      const real = realpathSync(s.path);
      if (!real.startsWith(this.root + sep)) { s.error = true; return; }
      const size = fstatSync(fd).size;
      if (size < s.offset) { // 파일이 줄었다: 처음부터 다시 읽는다
        s.offset = 0; s.carry = Buffer.alloc(0); s.timeline.reset();
      }
      const pieces: Piece[] = [];
      while (s.offset < size) {
        const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - s.offset));
        const n = readSync(fd, buf, 0, buf.length, s.offset);
        if (n <= 0) break;
        s.offset += n;
        const data = s.carry.length ? Buffer.concat([s.carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        // 줄바꿈으로 끝나지 않은 마지막 줄은 쓰는 도중일 수 있다. 다음에 읽는다.
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline < 0) { s.carry = Buffer.from(data); continue; }
        s.carry = Buffer.from(data.subarray(lastNewline + 1));
        for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
          if (line) pieces.push(...parseLine(line));
        }
      }
      s.error = false;
      if (!pieces.length) return;
      s.timeline.push(pieces);
      const last = pieces[pieces.length - 1]!;
      // 방금 읽은 것의 끝이 "중단됨" 이고 그 뒤로 일한다는 신호가 없었다면 에이전트는 입력을 기다리고 있다.
      if (last.type === 'interrupted' && last.at >= s.lastWorkSignalAt - 1000) {
        s.workingSince = null;
        s.pendingPermission = null;
        s.lastTool = null;
        this.schedule();
        this.d.onInterrupted?.(workspaceId);
      }
    } catch {
      s.error = true;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* 이미 닫힘 */ }
    }
  }

  snapshot(workspaceId: string): ChatSnapshot {
    const ws = this.d.workspaces.get(workspaceId);
    const empty = { items: [], hidden: 0, workingSince: null, pendingPermission: null };
    if (!ws) return { available: false, reason: '워크스페이스가 없습니다.', ...empty };
    if (ws.agentKind !== 'claude') return { available: false, reason: CODEX, ...empty };
    const s = this.states.get(workspaceId);
    if (!s) return { available: true, reason: null, ...empty };
    if (s.error) return { available: false, reason: UNREADABLE, ...empty };
    const all = s.timeline.items();
    const hidden = Math.max(0, all.length - MAX_ITEMS);
    // 원문은 펼칠 때 step() 으로 따로 가져간다: 긴 대화에서 매번 다 보내면 느리다.
    const items = all.slice(hidden).map((i): ChatItem => (i.kind === 'steps' ? { ...i, steps: i.steps.map((st) => ({ ...st, input: '', output: null })) } : i));
    return { available: true, reason: null, items, hidden, workingSince: s.workingSince, pendingPermission: s.pendingPermission };
  }

  /** 단계 하나의 입력·출력 원문 */
  step(workspaceId: string, stepId: string): { input: string; output: string | null } | null {
    const st = this.states.get(workspaceId)?.timeline.step(stepId);
    return st ? { input: st.input, output: st.output } : null;
  }

  hasPendingPermission(workspaceId: string): boolean {
    return this.states.get(workspaceId)?.pendingPermission?.canAnswer === true;
  }

  /** 승인 창에 답을 써 넣었다. 같은 창에 두 번 답하지 않게 한다. */
  permissionAnswered(workspaceId: string): void {
    const s = this.states.get(workspaceId);
    if (!s?.pendingPermission) return;
    s.pendingPermission = null;
    this.emit('changed', workspaceId);
  }

  /** 사용자가 에이전트 터미널에 직접 입력했다. 승인 창의 커서가 옮겨졌을 수 있으니 채팅에서는 답하지 못하게 한다. */
  noteTerminalInput(workspaceId: string): void {
    const s = this.states.get(workspaceId);
    if (!s?.pendingPermission?.canAnswer) return;
    s.pendingPermission = { ...s.pendingPermission, canAnswer: false };
    this.emit('changed', workspaceId);
  }

  /** 두레가 에이전트를 중단시켰다 (hook 이 오지 않는다). */
  interrupted(workspaceId: string): void {
    const s = this.states.get(workspaceId);
    if (!s) return;
    const before = this.fingerprint(s);
    s.workingSince = null;
    s.pendingPermission = null;
    s.lastTool = null;
    this.schedule();
    for (const ms of [400, 1500]) this.later(workspaceId, s, ms);
    if (this.fingerprint(s) !== before) this.emit('changed', workspaceId);
  }

  /** 에이전트 터미널이 끝났다. 지난 대화는 다음 대화가 시작될 때까지 남겨 둔다. */
  agentExited(workspaceId: string): void {
    const s = this.states.get(workspaceId);
    if (!s) return;
    this.read(workspaceId, s);
    s.workingSince = null;
    s.pendingPermission = null;
    s.lastTool = null;
    s.timeline.endRunning(Date.now());
    s.timeline.version++;
    this.schedule();
    this.emit('changed', workspaceId);
  }

  forget(workspaceId: string): void {
    const s = this.states.get(workspaceId);
    if (!s) return;
    for (const t of s.timers) clearTimeout(t);
    this.states.delete(workspaceId);
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.states.keys()]) this.forget(id);
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }
}
