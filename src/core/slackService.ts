import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { SlackAccess, SlackRequest, SlackStatus } from '@shared/types';
import type { SecretBox } from './dbService';
import type { MessageService } from './messages';
import type { WorkspaceStore } from './stores';

/** 에이전트가 슬랙에서 읽으려는 것 */
export type SlackOp =
  | { kind: 'channels'; query?: string }
  | { kind: 'history'; channel: string; limit?: number; before?: string; after?: string }
  | { kind: 'thread'; channel?: string; ts?: string; url?: string }
  | { kind: 'search'; query: string; limit?: number };

export interface SlackMessage { user: string; time: string; text: string; ts: string; replies?: number; thread?: string; channel?: string; link?: string }
export interface SlackResult { kind: SlackOp['kind']; channels?: { id: string; name: string; type: string }[]; channel?: string; messages?: SlackMessage[]; truncated: boolean }
export type SlackAnswer = { kind: 'result'; result: SlackResult } | { kind: 'pending'; requestId: string };

interface Row { id: number; secret: string; team: string; user: string; access: string; created_at: number }
interface Held extends SlackRequest { op: SlackOp; status: 'pending' | 'approved' | 'denied' | 'failed'; error?: string; result?: SlackResult; waiter?: (r: Held) => void; announced: boolean; running: boolean; token: string }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

const ACCESS: SlackAccess[] = ['ask', 'auto', 'off'];
/** 승인을 기다리며 도구 호출을 붙잡아 두는 시간. 넘으면 "기다리는 중" 으로 돌려주고, 결정되면 메시지로 알린다 */
const WAIT_MS = 40_000;
const KEEP_REQUESTS = 50;
const REQUEST_MS = 15_000;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_HISTORY = 50;
const MAX_THREAD = 100;
const MAX_SEARCH = 20;
const MAX_CHANNELS = 200;
/** 한 메시지와 결과 전체의 글자 상한. 넘으면 뒤를 뺀다 */
const MAX_TEXT = 4000;
const MAX_CHARS = 60_000;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const TOKEN = /^xox[pb]-[A-Za-z0-9-]{10,300}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,20}$/;
const TS = /^\d{6,12}\.\d{1,6}$/;

/** 슬랙이 돌려준 오류를 사용자와 에이전트가 알 수 있는 말로. 토큰은 어디에도 넣지 않는다. */
function slackError(code: string, needed?: string): Error {
  const known: Record<string, string> = {
    invalid_auth: '슬랙 토큰이 올바르지 않습니다.',
    not_authed: '슬랙 토큰이 올바르지 않습니다.',
    account_inactive: '슬랙 토큰의 계정이 비활성 상태입니다.',
    token_revoked: '슬랙 토큰이 폐기됐습니다. 설정에서 다시 연결하세요.',
    token_expired: '슬랙 토큰이 만료됐습니다. 설정에서 다시 연결하세요.',
    channel_not_found: '그 채널을 찾을 수 없습니다 (없거나 볼 수 없는 채널입니다).',
    not_in_channel: '그 채널에 들어가 있지 않아 읽을 수 없습니다.',
    thread_not_found: '그 스레드를 찾을 수 없습니다.',
    ratelimited: '슬랙이 요청이 너무 잦다고 합니다. 잠시 뒤에 다시 하세요.',
    not_allowed_token_type: '이 토큰으로는 할 수 없는 일입니다 (검색은 사용자 토큰만 됩니다).',
  };
  if (code === 'missing_scope') return new Error(`슬랙 토큰에 권한이 없습니다${needed ? ` (필요한 권한: ${oneLine(needed, 200)})` : ''}. 슬랙 앱의 User Token Scopes 에 더하고 다시 설치하세요.`);
  return new Error(known[code] ?? `슬랙이 요청을 받지 않았습니다 (${oneLine(code, 60) || '알 수 없는 오류'}).`);
}

/** 슬랙 메시지 주소에서 채널과 시각을 꺼낸다: https://팀.slack.com/archives/C123/p1700000000123456?thread_ts=1700000000.123456 */
export function parseSlackUrl(url: string): { channel: string; ts: string; thread?: string } | null {
  let u: URL;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)slack\.com$/i.test(u.hostname)) return null;
  const m = /^\/archives\/([CGD][A-Z0-9]{6,20})\/p(\d{10})(\d{6})$/.exec(u.pathname);
  if (!m) return null;
  const thread = u.searchParams.get('thread_ts') ?? undefined;
  return { channel: m[1]!, ts: `${m[2]}.${m[3]}`, ...(thread && TS.test(thread) ? { thread } : {}) };
}

/** 에이전트의 요청을 확인하고 다듬는다. 사용자에게 보일 설명(what)도 만든다. */
export function cleanSlackOp(raw: SlackOp): { op: SlackOp; what: string } {
  const day = (s: unknown, name: string): string | undefined => {
    if (s === undefined || s === null || s === '') return undefined;
    const t = Date.parse(String(s));
    if (Number.isNaN(t)) throw new Error(`${name} 은 날짜여야 한다 (예: 2026-11-12 또는 2026-11-12T09:00:00+09:00).`);
    return new Date(t).toISOString();
  };
  if (raw.kind === 'channels') {
    const query = oneLine(raw.query, 80);
    return { op: { kind: 'channels', ...(query ? { query } : {}) }, what: query ? `채널 목록에서 "${query}" 찾기` : '채널 목록 보기' };
  }
  if (raw.kind === 'history') {
    const channel = oneLine(raw.channel, 120).replace(/^#/, '');
    if (!channel) throw new Error('channel 을 적어라 (채널 이름이나 id).');
    const limit = Math.min(MAX_HISTORY, Math.max(1, Math.floor(Number(raw.limit) || 30)));
    const before = day(raw.before, 'before'); const after = day(raw.after, 'after');
    return { op: { kind: 'history', channel, limit, ...(before ? { before } : {}), ...(after ? { after } : {}) }, what: `채널 "${channel}" 의 메시지 ${limit}개까지${after ? `, ${after.slice(0, 16)} 이후` : ''}${before ? `, ${before.slice(0, 16)} 이전` : ''}` };
  }
  if (raw.kind === 'thread') {
    if (raw.url) {
      const p = parseSlackUrl(raw.url);
      if (!p) throw new Error('슬랙 메시지의 주소가 아니다 (https://…slack.com/archives/채널/p숫자 꼴이어야 한다).');
      return { op: { kind: 'thread', channel: p.channel, ts: p.thread ?? p.ts }, what: `스레드 읽기 (${oneLine(raw.url, 200)})` };
    }
    const channel = oneLine(raw.channel, 120).replace(/^#/, '');
    const ts = oneLine(raw.ts, 30);
    if (!channel || !TS.test(ts)) throw new Error('스레드는 url 을 주거나, channel 과 ts (slack_history 가 돌려준 ts) 를 줘야 한다.');
    return { op: { kind: 'thread', channel, ts }, what: `채널 "${channel}" 의 스레드 (${ts})` };
  }
  if (raw.kind === 'search') {
    const query = oneLine(raw.query, 300);
    if (!query) throw new Error('query 를 적어라.');
    const limit = Math.min(MAX_SEARCH, Math.max(1, Math.floor(Number(raw.limit) || 10)));
    return { op: { kind: 'search', query, limit }, what: `슬랙 전체에서 "${query}" 검색 (${limit}개까지)` };
  }
  throw new Error('할 수 없는 요청이다.');
}

/**
 * 슬랙 읽기. 사용자가 설정에 넣은 토큰으로 채널 목록, 채널의 메시지, 스레드, 검색 결과를 읽는다. 쓰지 않는다 (올리는 기능이 없다).
 * - 토큰은 암호화해 두고 화면에도 에이전트에게도 돌려주지 않는다. slack.com 으로만 보낸다.
 * - 에이전트가 읽을 때: "물어보고 읽기" 면 사용자가 무엇을 읽는지 보고 허용해야 읽는다. "바로 읽기" 면 묻지 않는다. "끔" 이면 읽지 못한다.
 * - 읽은 글은 다른 사람들이 쓴 것이다. 에이전트에게 줄 때 지시가 아니라고 알린다 (도구 쪽).
 * 이벤트: 'changed' — 연결이나 요청이 바뀜
 */
export class SlackService extends EventEmitter {
  private readonly requests = new Map<string, Held>();
  private readonly users = new Map<string, string>();
  private readonly channelNames = new Map<string, string>();

  constructor(private readonly d: {
    db: Database.Database; workspaces: WorkspaceStore; messages: MessageService; secrets: SecretBox;
    isProjectClosed(projectId: string): boolean;
    /** 시험에서 가짜 슬랙으로 바꾼다 */
    fetch?: Fetch;
    waitMs?: number;
  }) {
    super();
  }

  private row(): Row | undefined {
    return this.d.db.prepare('SELECT * FROM slack_connection WHERE id = 1').get() as Row | undefined;
  }

  status(): SlackStatus {
    const r = this.row();
    return { connected: r !== undefined, team: r?.team ?? '', user: r?.user ?? '', access: ACCESS.includes(r?.access as SlackAccess) ? r!.access as SlackAccess : 'ask' };
  }

  /** 토큰을 확인하고 저장한다. 슬랙에 한 번 물어 누구의 토큰인지 알아 둔다. */
  async connect(token: string): Promise<SlackStatus> {
    const t = String(token ?? '').trim();
    if (!TOKEN.test(t)) throw new Error('슬랙 토큰이 아닙니다 (xoxp- 로 시작하는 사용자 토큰을 넣으세요).');
    const me = await this.api(t, 'auth.test', {});
    // 암호화할 수 없는 환경이면 여기서 던진다: 토큰을 그대로 적어 두지 않는다.
    const secret = this.d.secrets.encrypt(t);
    this.d.db.prepare('INSERT INTO slack_connection (id, secret, team, user, access, created_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, team = excluded.team, user = excluded.user')
      .run(secret, oneLine(me.team, 80), oneLine(me.user, 80), 'ask', Date.now());
    this.users.clear(); this.channelNames.clear();
    this.denyAll('슬랙 연결이 바뀌었다');
    this.emit('changed');
    return this.status();
  }

  disconnect(): void {
    this.d.db.prepare('DELETE FROM slack_connection WHERE id = 1').run();
    this.users.clear(); this.channelNames.clear();
    this.denyAll('사용자가 슬랙 연결을 끊었다');
    this.emit('changed');
  }

  setAccess(access: SlackAccess): SlackStatus {
    if (!ACCESS.includes(access)) throw new Error('읽는 방식이 올바르지 않습니다.');
    if (!this.row()) throw new Error('슬랙이 연결돼 있지 않습니다.');
    this.d.db.prepare('UPDATE slack_connection SET access = ? WHERE id = 1').run(access);
    if (access === 'off') this.denyAll('사용자가 에이전트의 슬랙 읽기를 껐다');
    this.emit('changed');
    return this.status();
  }

  private denyAll(why: string): void {
    for (const q of this.requests.values()) if (q.status === 'pending') this.settle(q, 'denied', why);
  }

  // ---- 슬랙 API ----

  private async api(token: string, method: string, params: Record<string, string | number | boolean | undefined>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    const doFetch: Fetch = this.d.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'error' }));
    let res: Awaited<ReturnType<Fetch>>;
    try {
      // 주소는 고정이다: 토큰이 slack.com 밖으로 나가지 않는다.
      res = await doFetch(`https://slack.com/api/${method}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: body.toString(), signal: AbortSignal.timeout(REQUEST_MS),
      });
    } catch {
      throw new Error('슬랙에 닿지 않습니다 (네트워크를 확인하세요).');
    }
    if (res.status === 429) throw slackError('ratelimited');
    const text = await res.text();
    if (text.length > MAX_RESPONSE) throw new Error('슬랙의 응답이 너무 큽니다.');
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error(`슬랙이 알 수 없는 응답을 줬습니다 (HTTP ${res.status}).`); }
    if (!isObj(json) || json.ok !== true) throw slackError(isObj(json) ? String(json.error ?? '') : '', isObj(json) ? String(json.needed ?? '') : undefined);
    return json;
  }

  private async userName(token: string, id: string): Promise<string> {
    if (!id) return '알 수 없음';
    const cached = this.users.get(id);
    if (cached) return cached;
    let name = id;
    try {
      const r = await this.api(token, 'users.info', { user: id });
      const u = isObj(r.user) ? r.user : {};
      const p = isObj(u.profile) ? u.profile : {};
      name = oneLine(p.display_name || u.real_name || u.name || id, 60);
    } catch { /* 이름을 못 얻으면 id 로 */ }
    if (this.users.size > 2000) this.users.clear();
    this.users.set(id, name);
    return name;
  }

  /** 글 안의 <@U123> 을 이름으로 바꾼다. */
  private async readable(token: string, text: string): Promise<string> {
    const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]{6,20})>/g)].map((m) => m[1]!))].slice(0, 20);
    let out = text;
    for (const id of ids) out = out.split(`<@${id}>`).join(`@${await this.userName(token, id)}`);
    return out.slice(0, MAX_TEXT);
  }

  private async toMessage(token: string, m: Record<string, unknown>): Promise<SlackMessage> {
    const ts = String(m.ts ?? '');
    const who = m.user ? await this.userName(token, String(m.user)) : oneLine(m.username ?? (isObj(m.bot_profile) ? m.bot_profile.name : '') ?? '봇', 60) || '봇';
    const files = Array.isArray(m.files) ? m.files.filter(isObj).map((f) => oneLine(f.name ?? f.title, 80)).filter(Boolean) : [];
    const text = `${await this.readable(token, String(m.text ?? ''))}${files.length ? `\n[파일: ${files.join(', ')}]` : ''}`;
    return {
      user: who, time: new Date(Number(ts.split('.')[0]) * 1000).toISOString(), text, ts,
      ...(Number(m.reply_count) > 0 ? { replies: Number(m.reply_count) } : {}),
      ...(m.thread_ts && m.thread_ts !== m.ts ? { thread: String(m.thread_ts) } : {}),
    };
  }

  private async listChannels(token: string): Promise<{ id: string; name: string; type: string }[]> {
    const out: { id: string; name: string; type: string }[] = [];
    let cursor: string | undefined;
    // 다섯 쪽까지만 넘긴다 (채널이 아주 많은 곳에서 끝없이 읽지 않게).
    for (let page = 0; page < 5; page += 1) {
      const r = await this.api(token, 'conversations.list', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200, cursor });
      for (const c of (Array.isArray(r.channels) ? r.channels : []).filter(isObj)) {
        const id = String(c.id ?? '');
        if (!CHANNEL_ID.test(id)) continue;
        const type = c.is_im ? '개인 메시지' : c.is_mpim ? '여럿이 하는 개인 메시지' : c.is_private ? '비공개 채널' : '채널';
        const name = c.is_im ? `@${await this.userName(token, String(c.user ?? ''))}` : oneLine(c.name, 80);
        out.push({ id, name, type });
        this.channelNames.set(id, name);
      }
      cursor = isObj(r.response_metadata) ? String(r.response_metadata.next_cursor ?? '') || undefined : undefined;
      if (!cursor) break;
    }
    return out;
  }

  private async channelId(token: string, channel: string): Promise<{ id: string; name: string }> {
    if (CHANNEL_ID.test(channel)) return { id: channel, name: this.channelNames.get(channel) ?? channel };
    const all = await this.listChannels(token);
    const exact = all.filter((c) => c.name === channel || c.name === `@${channel}`);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) throw new Error(`"${channel}" 이라는 채널이 둘 이상이다. slack_channels 로 id 를 확인해 id 로 적어라.`);
    const near = all.filter((c) => c.name.includes(channel)).slice(0, 10).map((c) => c.name);
    throw new Error(`"${channel}" 이라는 채널이 없다${near.length ? `. 비슷한 것: ${near.join(', ')}` : ' (슬랙 계정이 볼 수 있는 채널만 읽을 수 있다)'}.`);
  }

  private cap(result: SlackResult): SlackResult {
    let total = 0;
    const kept: SlackMessage[] = [];
    for (const m of result.messages ?? []) {
      total += m.text.length + 80;
      if (total > MAX_CHARS) return { ...result, messages: kept, truncated: true };
      kept.push(m);
    }
    return result;
  }

  private async run(token: string, op: SlackOp): Promise<SlackResult> {
    if (op.kind === 'channels') {
      const all = await this.listChannels(token);
      const q = (op.query ?? '').toLowerCase();
      const hit = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
      return { kind: 'channels', channels: hit.slice(0, MAX_CHANNELS), truncated: hit.length > MAX_CHANNELS };
    }
    if (op.kind === 'history') {
      const ch = await this.channelId(token, op.channel);
      const r = await this.api(token, 'conversations.history', {
        channel: ch.id, limit: op.limit ?? 30,
        latest: op.before ? Date.parse(op.before) / 1000 : undefined, oldest: op.after ? Date.parse(op.after) / 1000 : undefined,
      });
      const list = (Array.isArray(r.messages) ? r.messages : []).filter(isObj);
      const messages = await Promise.all(list.map((m) => this.toMessage(token, m)));
      // 슬랙은 새 것부터 준다. 읽기 쉽게 옛 것부터 돌려준다.
      return this.cap({ kind: 'history', channel: ch.name, messages: messages.reverse(), truncated: r.has_more === true });
    }
    if (op.kind === 'thread') {
      const ch = await this.channelId(token, op.channel ?? '');
      const r = await this.api(token, 'conversations.replies', { channel: ch.id, ts: op.ts, limit: MAX_THREAD });
      const list = (Array.isArray(r.messages) ? r.messages : []).filter(isObj);
      return this.cap({ kind: 'thread', channel: ch.name, messages: await Promise.all(list.map((m) => this.toMessage(token, m))), truncated: r.has_more === true });
    }
    const r = await this.api(token, 'search.messages', { query: op.query, count: op.limit ?? 10, sort: 'timestamp', sort_dir: 'desc' });
    const found = isObj(r.messages) && Array.isArray(r.messages.matches) ? r.messages.matches.filter(isObj) : [];
    const messages = await Promise.all(found.map(async (m) => ({
      ...(await this.toMessage(token, m)),
      channel: oneLine(isObj(m.channel) ? m.channel.name : '', 80),
      ...(typeof m.permalink === 'string' && parseSlackUrl(m.permalink) ? { link: m.permalink } : {}),
    })));
    const total = isObj(r.messages) ? Number(r.messages.total) : messages.length;
    return this.cap({ kind: 'search', messages, truncated: total > messages.length });
  }

  // ---- 에이전트 ----

  /**
   * 에이전트가 슬랙을 읽는다. "바로 읽기" 면 결과를, "물어보고 읽기" 면 사용자의 결정을 기다린다.
   * 오래 기다리게 되면 "기다리는 중" 으로 돌려주고, 결정되면 두레의 알림으로 알린다 (agentResult 로 결과를 받는다).
   */
  async agentRead(workspaceId: string, raw: SlackOp): Promise<SlackAnswer> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error('워크스페이스가 없다.');
    if (this.d.isProjectClosed(ws.projectId)) throw new Error('완료된 프로젝트다.');
    const r = this.row();
    if (!r) throw new Error('슬랙이 연결돼 있지 않다. 사용자에게 두레의 설정에서 슬랙을 연결해 달라고 하라.');
    if (r.access === 'off') throw new Error('사용자가 에이전트의 슬랙 읽기를 꺼 두었다. 필요하면 사용자에게 두레의 설정에서 켜 달라고 하라.');
    const { op, what } = cleanSlackOp(raw);
    const token = this.d.secrets.decrypt(r.secret);
    if (r.access === 'auto') return { kind: 'result', result: await this.run(token, op) };
    const mine = [...this.requests.values()].filter((q) => q.workspaceId === workspaceId && q.status === 'pending');
    if (mine.length >= 3) throw new Error('승인을 기다리는 슬랙 읽기가 이미 3개다. 사용자의 결정을 기다려라.');
    const held: Held = { id: crypto.randomUUID(), projectId: ws.projectId, workspaceId, what, createdAt: Date.now(), op, status: 'pending', announced: false, running: false, token: r.secret };
    this.requests.set(held.id, held);
    for (const old of [...this.requests.values()].filter((q) => q.status !== 'pending').slice(0, Math.max(0, this.requests.size - KEEP_REQUESTS))) this.requests.delete(old.id);
    this.emit('changed');
    const decided = await new Promise<Held | null>((resolve) => {
      const timer = setTimeout(() => { held.waiter = undefined; resolve(null); }, this.d.waitMs ?? WAIT_MS);
      held.waiter = (q) => { clearTimeout(timer); resolve(q); };
    });
    if (!decided) { held.announced = true; return { kind: 'pending', requestId: held.id }; }
    return this.take(decided);
  }

  private take(q: Held): SlackAnswer {
    if (q.status === 'pending' || q.running) return { kind: 'pending', requestId: q.id };
    if (q.status === 'denied') throw new Error(`사용자가 이 슬랙 읽기를 거절했다${q.error ? ` (${q.error})` : ''}. 같은 것을 다시 요청하지 말고, 필요하면 사용자에게 이유를 물어라.`);
    if (q.status === 'failed' || !q.result) throw new Error(`슬랙을 읽지 못했다: ${q.error ?? '알 수 없는 오류'}`);
    return { kind: 'result', result: q.result };
  }

  /** 기다리다 돌려보낸 읽기의 결과를 에이전트가 받는다. 요청한 워크스페이스만 받을 수 있다. */
  agentResult(workspaceId: string, requestId: string): SlackAnswer {
    const q = this.requests.get(String(requestId));
    if (!q || q.workspaceId !== workspaceId) throw new Error('그런 슬랙 읽기 요청이 없다 (두레를 다시 켜면 요청은 사라진다. 다시 요청하라).');
    return this.take(q);
  }

  /** 결정을 기다리는 읽기 요청. */
  pending(projectId: string): SlackRequest[] {
    if (this.d.isProjectClosed(projectId)) {
      for (const q of this.requests.values()) if (q.projectId === projectId && q.status === 'pending') this.settle(q, 'denied', '프로젝트가 완료됐다');
      return [];
    }
    return [...this.requests.values()].filter((q) => q.projectId === projectId && q.status === 'pending')
      .map(({ id, projectId: p, workspaceId, what, createdAt }) => ({ id, projectId: p, workspaceId, what, createdAt }));
  }

  private settle(q: Held, status: Held['status'], error?: string, result?: SlackResult): void {
    q.status = status; q.error = error; q.result = result; q.running = false;
    const waiter = q.waiter;
    q.waiter = undefined;
    if (waiter) { waiter(q); return; }
    if (!q.announced) return;
    const head = status === 'approved' ? '사용자가 슬랙 읽기를 허용했고 두레가 읽었다.' : status === 'denied' ? '사용자가 슬랙 읽기를 거절했다.' : '사용자가 슬랙 읽기를 허용했지만 읽지 못했다.';
    try {
      this.d.messages.send({ projectId: q.projectId, from: { kind: 'system' }, toWorkspaceId: q.workspaceId, title: '슬랙', body: `${head} slack_result 도구에 request_id "${q.id}" 를 줘서 결과를 받아라.` });
    } catch { /* 알림 실패가 결정을 바꾸면 안 된다 */ }
  }

  /**
   * 사용자가 읽기 요청을 결정한다. 허용하면 두레가 읽는다.
   * always: 앞으로 묻지 않고 읽게 한다 ("바로 읽기").
   */
  async decide(requestId: string, allow: boolean, o: { always?: boolean } = {}): Promise<void> {
    const q = this.requests.get(requestId);
    if (!q || q.status !== 'pending') throw new Error('결정을 기다리는 요청이 아닙니다.');
    if (!allow) { this.settle(q, 'denied'); this.emit('changed'); return; }
    // 요청한 뒤에 사정이 바뀌었으면 읽지 않는다: 사용자는 요청 때의 연결을 보고 허용한 것이다.
    const now = this.row();
    const stale = this.d.isProjectClosed(q.projectId) ? '프로젝트가 완료됐다' : !now ? '슬랙 연결이 끊겼다' : now.access === 'off' ? '에이전트의 슬랙 읽기가 꺼져 있다' : now.secret !== q.token ? '요청한 뒤에 슬랙 연결이 바뀌었다' : null;
    if (stale || !now) { this.settle(q, 'denied', stale ?? '슬랙 연결이 끊겼다'); this.emit('changed'); throw new Error(`읽지 않았습니다: ${stale}.`); }
    // 두 번 눌러도 한 번만 읽는다.
    q.status = 'approved'; q.running = true;
    this.emit('changed');
    try {
      const result = await this.run(this.d.secrets.decrypt(now.secret), q.op);
      if (o.always && now.access === 'ask') this.d.db.prepare("UPDATE slack_connection SET access = 'auto' WHERE id = 1 AND access = 'ask'").run();
      this.settle(q, 'approved', undefined, result);
    } catch (e) {
      this.settle(q, 'failed', e instanceof Error ? e.message : String(e));
    }
    this.emit('changed');
  }

  /** 워크스페이스가 지워질 때: 기다리던 요청을 거절로 끝낸다. */
  dropWorkspace(workspaceId: string): void {
    for (const q of this.requests.values()) if (q.workspaceId === workspaceId && q.status === 'pending') { this.settle(q, 'denied', '워크스페이스가 없어졌다'); this.emit('changed'); }
  }
}
