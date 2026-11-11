import { EventEmitter } from 'node:events';
import type { ChatPermission, ChatQuestion, SlashCommand } from '@shared/types';
import { AgentSession, type AgentEvent, type SessionSpawn } from '../agents/session';
import { stepInput, stepSummary } from './transcript';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Pending {
  requestId: string;
  tool: string;
  input: unknown;
  /** "앞으로 묻지 않기" 로 답할 때 돌려줄 규칙 (에이전트가 제안한 것 그대로) */
  suggestions: unknown[];
}

interface Live {
  session: AgentSession;
  /** 지금 쓰고 있는 글 (아직 한 덩어리가 끝나지 않았다). 없으면 null */
  streaming: string | null;
  pending: Pending | null;
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

/**
 * 채팅 방식의 에이전트들. 터미널 화면 없이 구조화된 입출력으로 돈다 (실험 17, 18).
 * 승인과 질문은 이벤트로 오고 답도 이벤트로 보낸다: 화면 글자를 읽거나 키 입력을 흉내 내지 않는다.
 * 이벤트: 'changed' (workspaceId) — 쓰는 중인 글, 승인·질문 대기가 바뀜
 */
export class ChatEngine extends EventEmitter {
  private readonly live = new Map<string, Live>();

  constructor(private readonly hooks: EngineHooks) {
    super();
  }

  has(workspaceId: string): boolean {
    return this.live.get(workspaceId)?.session.alive === true;
  }

  start(workspaceId: string, spec: SessionSpawn): void {
    if (this.has(workspaceId)) return;
    const session = new AgentSession(spec);
    const l: Live = { session, streaming: null, pending: null, commands: [], flush: null };
    this.live.set(workspaceId, l);
    session.on('event', (e: AgentEvent) => { try { this.onEvent(workspaceId, l, e); } catch { /* 모르는 모양의 이벤트는 건너뛴다 */ } });
    session.on('exit', (code: number | null, stderr: string) => {
      if (l.flush) clearTimeout(l.flush);
      if (this.live.get(workspaceId) === l) this.live.delete(workspaceId);
      this.hooks.onExit(workspaceId, code, stderr);
      this.emit('changed', workspaceId);
    });
    // 쓸 수 있는 슬래시 명령과 그 설명을 받아 둔다. 실패해도 대화에는 지장이 없다.
    session.control<{ commands?: unknown }>({ subtype: 'initialize' }).then((r) => {
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
        if (r.subtype !== 'can_use_tool' || !requestId) return;
        l.pending = { requestId, tool: str(r.tool_name), input: r.input, suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [] };
        this.hooks.onWaiting(workspaceId, true);
        this.emit('changed', workspaceId);
        return;
      }
      case 'control_cancel_request':
        // 에이전트가 물음을 거둬들였다 (멈춤 등).
        if (l.pending && l.pending.requestId === str(e.request_id)) { l.pending = null; this.emit('changed', workspaceId); }
        return;
      case 'result':
        l.streaming = null;
        l.pending = null;
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

  /** 승인 요청에 답한다. always: 허용하고, 에이전트가 제안한 규칙으로 앞으로는 묻지 않게 한다. */
  answerPermission(workspaceId: string, answer: 'allow' | 'deny' | 'always'): void {
    const l = this.mustGet(workspaceId);
    const p = l.pending;
    if (!p || p.tool === 'AskUserQuestion') throw new Error('승인을 기다리는 중이 아닙니다.');
    if (answer !== 'allow' && answer !== 'deny' && answer !== 'always') throw new Error('알 수 없는 답입니다.');
    if (answer === 'always' && p.suggestions.length === 0) throw new Error('이 요청에는 "앞으로 묻지 않기" 를 쓸 수 없습니다.');
    l.pending = null; // 같은 요청에 두 번 답하지 않는다
    l.session.respond(p.requestId, answer === 'deny'
      ? { behavior: 'deny', message: DENIED }
      : { behavior: 'allow', updatedInput: isObj(p.input) ? p.input : {}, ...(answer === 'always' ? { updatedPermissions: p.suggestions } : {}) });
    this.hooks.onWaiting(workspaceId, false);
    this.emit('changed', workspaceId);
  }

  /** 여러 선택지 질문에 답한다. answers: 질문 글 → 고른 선택지(여러 개면 ", " 로 이음) 또는 직접 쓴 답 */
  answerQuestion(workspaceId: string, answers: Record<string, string>): void {
    const l = this.mustGet(workspaceId);
    const p = l.pending;
    if (!p || p.tool !== 'AskUserQuestion') throw new Error('질문을 기다리는 중이 아닙니다.');
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers ?? {})) if (typeof v === 'string' && v.trim()) clean[k] = v.trim().slice(0, 2000);
    if (Object.keys(clean).length === 0) throw new Error('답을 고르세요.');
    l.pending = null;
    l.session.respond(p.requestId, { behavior: 'allow', updatedInput: { ...(isObj(p.input) ? p.input : {}), answers: clean } });
    this.hooks.onWaiting(workspaceId, false);
    this.emit('changed', workspaceId);
  }

  /** 질문에 답하지 않고 넘긴다. */
  dismissQuestion(workspaceId: string): void {
    const l = this.mustGet(workspaceId);
    const p = l.pending;
    if (!p || p.tool !== 'AskUserQuestion') throw new Error('질문을 기다리는 중이 아닙니다.');
    l.pending = null;
    l.session.respond(p.requestId, { behavior: 'deny', message: '사용자가 답하지 않고 넘겼습니다.' });
    this.hooks.onWaiting(workspaceId, false);
    this.emit('changed', workspaceId);
  }

  overlay(workspaceId: string): ChatOverlay {
    const l = this.live.get(workspaceId);
    if (!l) return { streaming: null, permission: null, question: null };
    const p = l.pending;
    if (p?.tool === 'AskUserQuestion') {
      const raw = isObj(p.input) && Array.isArray(p.input.questions) ? p.input.questions : [];
      const questions = raw.flatMap((q) => (isObj(q) && str(q.question) ? [{
        question: str(q.question), header: str(q.header), multiSelect: q.multiSelect === true,
        options: (Array.isArray(q.options) ? q.options : []).flatMap((o) => (isObj(o) && str(o.label) ? [{ label: str(o.label), description: str(o.description) }] : [])),
      }] : []));
      return { streaming: l.streaming, permission: null, question: { questions } };
    }
    return {
      streaming: l.streaming,
      permission: p ? { tool: p.tool, summary: stepSummary(p.tool, p.input), input: stepInput(p.tool, p.input), canAnswer: true, canAlways: p.suggestions.length > 0 } : null,
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
    const all = [...this.live.values()];
    for (const l of all) l.session.kill();
    const end = Date.now() + 3000;
    while (all.some((l) => l.session.alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  }
}
