import { EventEmitter } from 'node:events';
import type { ChatPermission, ChatQuestion, ModelChoice, SlashCommand } from '@shared/types';
import { AgentSession, type AgentEvent, type SessionSpawn } from '../agents/session';
import { stepInput, stepSummary } from './transcript';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Pending {
  requestId: string;
  tool: string;
  input: unknown;
  /** "앞으로 묻지 않기" 로 답할 때 돌려줄 규칙. 허용 규칙을 더하는 제안만, 이번 대화에만 적용되게 고친 것 */
  suggestions: unknown[];
  /** 그 규칙을 사람이 읽을 글로 */
  ruleText: string;
}

/**
 * 에이전트가 제안한 "앞으로 묻지 않기" 규칙 중 쓸 것만 고른다.
 * 허용 규칙을 더하는 제안만 받고, 적용 범위를 이번 대화로 고친다: 사용자의 저장소나 설정 파일에 남기지 않는다.
 */
export function sessionRules(suggestions: unknown): { rules: unknown[]; text: string } {
  const rules: unknown[] = [];
  const texts: string[] = [];
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!isObj(s) || s.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules)) continue;
    const list = s.rules.filter((r): r is Obj => isObj(r) && Boolean(str(r.toolName)));
    if (list.length === 0) continue;
    rules.push({ type: 'addRules', rules: list, behavior: 'allow', destination: 'session' });
    for (const r of list) texts.push(str(r.ruleContent) ? `${str(r.toolName)}: ${str(r.ruleContent)}` : str(r.toolName));
  }
  return { rules, text: texts.join(', ').slice(0, 300) };
}

interface Live {
  session: AgentSession;
  /** 지금 쓰고 있는 글 (아직 한 덩어리가 끝나지 않았다). 없으면 null */
  streaming: string | null;
  /** 답을 기다리는 요청들. 온 순서대로 하나씩 화면에 보인다 (하위 에이전트가 여럿이면 동시에 올 수 있다) */
  pending: Pending[];
  commands: SlashCommand[];
  flush: NodeJS.Timeout | null;
}

export interface ChatOverlay {
  streaming: string | null;
  permission: ChatPermission | null;
  question: ChatQuestion | null;
}

export interface EngineHooks {
  /** 대화가 시작됐다. 이어가기에 쓸 id */
  onSession(workspaceId: string, sessionId: string): void;
  /** 에이전트가 승인이나 답을 기다린다 / 답을 받아 다시 일한다 */
  onWaiting(workspaceId: string, waiting: boolean): void;
  /** 한 차례가 끝났다. interrupted: 사용자가 멈춰서 끝났다 (이때는 Stop hook 이 오지 않는다) */
  onTurnEnd(workspaceId: string, interrupted: boolean): void;
  /** 대화 기록이 바뀌었을 것이다 (에이전트의 글·도구 결과가 나왔다) */
  onActivity(workspaceId: string): void;
  onExit(workspaceId: string, code: number | null, stderr: string): void;
}

const DENIED = '사용자가 거부했습니다.';

function questionsOf(input: unknown): ChatQuestion['questions'] {
  const raw = isObj(input) && Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((q) => (isObj(q) && str(q.question) ? [{
    question: str(q.question), header: str(q.header), multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).flatMap((o) => (isObj(o) && str(o.label) ? [{ label: str(o.label), description: str(o.description) }] : [])),
  }] : []));
}

/**
 * 채팅 방식의 에이전트들. 터미널 화면 없이 구조화된 입출력으로 돈다 (실험 17, 18).
 * 승인과 질문은 이벤트로 오고 답도 이벤트로 보낸다: 화면 글자를 읽거나 키 입력을 흉내 내지 않는다.
 * 이벤트: 'changed' (workspaceId) — 쓰는 중인 글, 승인·질문 대기가 바뀜
 */
export class ChatEngine extends EventEmitter {
  private readonly live = new Map<string, Live>();
  /** 앱을 닫는 중이다. 이후에는 새로 띄우지 않는다 */
  private closed = false;
  /** 가장 최근에 에이전트가 알려 준 모델 목록 */
  private lastModels: ModelChoice[] = [];

  models(): ModelChoice[] {
    return this.lastModels;
  }

  constructor(private readonly hooks: EngineHooks) {
    super();
  }

  has(workspaceId: string): boolean {
    return this.live.get(workspaceId)?.session.alive === true;
  }

  /** 승인이나 답을 기다리는 요청이 있는가 */
  hasPending(workspaceId: string): boolean {
    return (this.live.get(workspaceId)?.pending.length ?? 0) > 0;
  }

  start(workspaceId: string, spec: SessionSpawn): void {
    if (this.closed) throw new Error('두레를 닫는 중입니다.');
    if (this.has(workspaceId)) return;
    const session = new AgentSession(spec);
    const l: Live = { session, streaming: null, pending: [], commands: [], flush: null };
    this.live.set(workspaceId, l);
    session.on('event', (e: AgentEvent) => { try { this.onEvent(workspaceId, l, e); } catch { /* 모르는 모양의 이벤트는 건너뛴다 */ } });
    session.on('exit', (code: number | null, stderr: string) => {
      if (l.flush) clearTimeout(l.flush);
      if (this.live.get(workspaceId) === l) this.live.delete(workspaceId);
      // 앱을 닫은 뒤에 끝난 프로세스는 상태 저장소를 건드리지 않는다 (이미 닫혀 있다).
      if (this.closed) return;
      try { this.hooks.onExit(workspaceId, code, stderr); } catch { /* 정리 중의 오류로 앱이 죽지 않게 한다 */ }
      this.emit('changed', workspaceId);
    });
    // 쓸 수 있는 슬래시 명령과 그 설명을 받아 둔다. 실패해도 대화에는 지장이 없다.
    session.control<{ commands?: unknown; models?: unknown }>({ subtype: 'initialize' }).then((r) => {
      // 고를 수 있는 모델 목록도 함께 온다. 설정 화면이 쓴다.
      const models = (Array.isArray(r?.models) ? r.models : []).flatMap((m): ModelChoice[] => (isObj(m) && str(m.value)
        ? [{ value: str(m.value), name: str(m.displayName) || str(m.value), description: str(m.description).slice(0, 200) }] : []));
      if (models.length) this.lastModels = models;
      const list = Array.isArray(r?.commands) ? r.commands : [];
      l.commands = list.flatMap((c): SlashCommand[] => (isObj(c) && str(c.name) ? [{ name: str(c.name), description: str(c.description).slice(0, 300), argumentHint: str(c.argumentHint) }] : []));
      this.emit('changed', workspaceId);
    }).catch(() => undefined);
  }

  /** 쓰는 중인 글은 조각마다 오므로 화면 알림을 묶는다. */
  private changedSoon(workspaceId: string, l: Live): void {
    if (l.flush) return;
    l.flush = setTimeout(() => { l.flush = null; this.emit('changed', workspaceId); }, 60);
    l.flush.unref();
  }

  private onEvent(workspaceId: string, l: Live, e: AgentEvent): void {
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init' && str(e.session_id)) this.hooks.onSession(workspaceId, str(e.session_id));
        return;
      case 'stream_event': {
        // 하위 에이전트의 글은 보이지 않는다.
        if (e.parent_tool_use_id) return;
        const ev = isObj(e.event) ? e.event : {};
        if (ev.type === 'message_start') { l.streaming = ''; this.changedSoon(workspaceId, l); }
        else if (ev.type === 'content_block_delta' && isObj(ev.delta) && ev.delta.type === 'text_delta') {
          l.streaming = (l.streaming ?? '') + str(ev.delta.text);
          this.changedSoon(workspaceId, l);
        }
        return;
      }
      case 'assistant':
      case 'user':
        if (e.parent_tool_use_id) return;
        // 한 덩어리가 끝나 기록에 남았다. 쓰는 중이던 글은 기록에서 읽은 것으로 바뀐다.
        if (e.type === 'assistant') l.streaming = null;
        this.hooks.onActivity(workspaceId);
        this.emit('changed', workspaceId);
        return;
      case 'control_request': {
        const r = isObj(e.request) ? e.request : {};
        const requestId = str(e.request_id);
        if (!requestId) return;
        if (r.subtype !== 'can_use_tool') {
          // 모르는 물음에는 모른다고 답한다: 답이 없으면 에이전트가 계속 기다린다.
          l.session.respondError(requestId, '두레가 처리하지 못하는 요청입니다.');
          return;
        }
        if (l.pending.some((p) => p.requestId === requestId)) return;
        const rule = sessionRules(r.permission_suggestions);
        l.pending.push({ requestId, tool: str(r.tool_name), input: r.input, suggestions: rule.rules, ruleText: rule.text });
        this.hooks.onWaiting(workspaceId, true);
        this.emit('changed', workspaceId);
        return;
      }
      case 'control_cancel_request': {
        // 에이전트가 물음을 거둬들였다 (멈춤 등).
        const before = l.pending.length;
        l.pending = l.pending.filter((p) => p.requestId !== str(e.request_id));
        if (l.pending.length !== before) {
          if (l.pending.length === 0) this.hooks.onWaiting(workspaceId, false);
          this.emit('changed', workspaceId);
        }
        return;
      }
      case 'result':
        l.streaming = null;
        l.pending = [];
        this.hooks.onActivity(workspaceId);
        this.hooks.onTurnEnd(workspaceId, e.subtype !== 'success');
        this.emit('changed', workspaceId);
        return;
      default:
        return;
    }
  }

  private mustGet(workspaceId: string): Live {
    const l = this.live.get(workspaceId);
    if (!l || !l.session.alive) throw new Error('에이전트가 꺼져 있습니다.');
    return l;
  }

  say(workspaceId: string, text: string): void {
    this.mustGet(workspaceId).session.say(text);
  }

  async interrupt(workspaceId: string): Promise<void> {
    const l = this.live.get(workspaceId);
    if (!l?.session.alive) return;
    await l.session.interrupt();
  }

  /**
   * 지금 화면에 보이는 요청(가장 먼저 온 것)을 꺼낸다. requestId 가 그것과 다르면 거절한다:
   * 화면이 바뀌는 사이에 누른 버튼이 사용자가 보지 않은 요청에 적용되면 안 된다.
   */
  private takeHead(workspaceId: string, requestId: string, question: boolean): { l: Live; p: Pending } {
    const l = this.mustGet(workspaceId);
    const p = l.pending[0];
    const none = question ? '질문을 기다리는 중이 아닙니다.' : '승인을 기다리는 중이 아닙니다.';
    if (!p || (p.tool === 'AskUserQuestion') !== question) throw new Error(none);
    if (p.requestId !== requestId) throw new Error('화면의 요청이 바뀌었습니다. 다시 확인하고 답하세요.');
    return { l, p };
  }

  /** 답한 요청을 줄에서 빼고, 더 기다리는 것이 없으면 다시 일하는 중으로 알린다. */
  private answered(workspaceId: string, l: Live, p: Pending): void {
    l.pending = l.pending.filter((x) => x !== p);
    if (l.pending.length === 0) this.hooks.onWaiting(workspaceId, false);
    this.emit('changed', workspaceId);
  }

  /** 승인 요청에 답한다. always: 허용하고, 이번 대화 동안 같은 것은 묻지 않게 한다. */
  answerPermission(workspaceId: string, requestId: string, answer: 'allow' | 'deny' | 'always'): void {
    if (answer !== 'allow' && answer !== 'deny' && answer !== 'always') throw new Error('알 수 없는 답입니다.');
    const { l, p } = this.takeHead(workspaceId, requestId, false);
    if (answer === 'always' && p.suggestions.length === 0) throw new Error('이 요청에는 "앞으로 묻지 않기" 를 쓸 수 없습니다.');
    l.session.respond(p.requestId, answer === 'deny'
      ? { behavior: 'deny', message: DENIED }
      : { behavior: 'allow', updatedInput: isObj(p.input) ? p.input : {}, ...(answer === 'always' ? { updatedPermissions: p.suggestions } : {}) });
    this.answered(workspaceId, l, p);
  }

  /** 여러 선택지 질문에 답한다. answers: 질문 글 → 고른 선택지(여러 개면 ", " 로 이음) 또는 직접 쓴 답. 모든 질문에 답해야 한다. */
  answerQuestion(workspaceId: string, requestId: string, answers: Record<string, string>): void {
    const { l, p } = this.takeHead(workspaceId, requestId, true);
    const asked = questionsOf(p.input).map((q) => q.question);
    const clean: Record<string, string> = {};
    for (const q of asked) {
      const v = isObj(answers) ? answers[q] : undefined;
      if (typeof v === 'string' && v.trim()) clean[q] = v.trim().slice(0, 2000);
    }
    if (asked.length === 0 || Object.keys(clean).length !== new Set(asked).size) throw new Error('모든 질문에 답하세요.');
    l.session.respond(p.requestId, { behavior: 'allow', updatedInput: { ...(isObj(p.input) ? p.input : {}), answers: clean } });
    this.answered(workspaceId, l, p);
  }

  /** 질문에 답하지 않고 넘긴다. */
  dismissQuestion(workspaceId: string, requestId: string): void {
    const { l, p } = this.takeHead(workspaceId, requestId, true);
    l.session.respond(p.requestId, { behavior: 'deny', message: '사용자가 답하지 않고 넘겼습니다.' });
    this.answered(workspaceId, l, p);
  }

  overlay(workspaceId: string): ChatOverlay {
    const l = this.live.get(workspaceId);
    if (!l) return { streaming: null, permission: null, question: null };
    const p = l.pending[0];
    if (p?.tool === 'AskUserQuestion') return { streaming: l.streaming, permission: null, question: { requestId: p.requestId, questions: questionsOf(p.input) } };
    return {
      streaming: l.streaming,
      permission: p ? {
        tool: p.tool, summary: stepSummary(p.tool, p.input), input: stepInput(p.tool, p.input), canAnswer: true,
        canAlways: p.suggestions.length > 0, alwaysRule: p.ruleText, requestId: p.requestId, more: l.pending.length - 1,
      } : null,
      question: null,
    };
  }

  commands(workspaceId: string): SlashCommand[] {
    return this.live.get(workspaceId)?.commands ?? [];
  }

  stop(workspaceId: string): void {
    this.live.get(workspaceId)?.session.kill();
  }

  /** 모두 끄고 끝날 때까지 (최대 3초) 기다린다. */
  async stopAll(): Promise<void> {
    this.closed = true;
    const all = [...this.live.values()];
    for (const l of all) l.session.kill();
    const end = Date.now() + 3000;
    while (all.some((l) => l.session.alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  }
}
