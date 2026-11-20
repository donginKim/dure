import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Settings, SlackCall, SlackCallKind, SlackWatchStatus } from '@shared/types';
import type { SlackSelf } from './slackService';

interface CallRow { id: string; kind: string; channel_id: string; channel_name: string; user_name: string; text: string; ts: string; permalink: string; seen: number; created_at: number }
interface ChannelRow { channel_id: string; name: string; kind: string; last_ts: string; active_at: number; checked_at: number }
type ChannelKind = 'channel' | 'private' | 'mpim' | 'im';

/** 확인하는 간격 */
const EVERY_MS = 5 * 60_000;
/** 내가 든 채널의 목록을 다시 받는 간격 */
const CHANNELS_MS = 60 * 60_000;
/** 한 번 확인할 때 읽는 채널의 수. 슬랙의 제한(분당 50번쯤)보다 넉넉히 아래 */
const BUDGET = 30;
/** 그중 요즘 글이 올라온 채널에 먼저 쓰는 몫: 조용한 채널이 많아도 활발한 채널은 매번 본다 */
const HOT = 20;
const HOT_MS = 3 * 24 * 60 * 60_000;
/** 검색이 안 되는 토큰이면 이만큼 쉬었다가 다시 해 본다 */
const SEARCH_OFF_MS = 60 * 60_000;
const KEEP = 500;
/** 한 채널에서 밀린 글을 읽는 쪽수 (한 쪽에 50건). 넘는 것은 건너뛴다 */
const PAGES = 3;
/** 이보다 자주는 확인하지 않는다 ("지금 확인" 을 연달아 눌러도) */
const MIN_GAP_MS = 10_000;
const MAX_TEXT = 500;
const CHANNEL_ID = /^[CGD][A-Z0-9]{6,20}$/;
const TS = /^\d{6,12}\.\d{1,6}$/;
const PERMALINK = /^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\/archives\/[CGD][A-Z0-9]{6,20}\/p\d{10,18}(\?[A-Za-z0-9_.=&%-]*)?$/;
/** 사람이 쓴 글이 아닌 것 (들어옴, 나감, 주제 바꿈 등) */
const NOISE = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive', 'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name', 'pinned_item', 'unpinned_item', 'message_deleted', 'message_changed', 'joiner_notification_for_inviter', 'bot_add', 'bot_remove', 'reminder_add']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const codeOf = (e: unknown): string => (isObj(e) && typeof e.slackCode === 'string' ? e.slackCode : '');
const after = (a: string, b: string): boolean => Number(a) > Number(b);
const toCall = (r: CallRow): SlackCall => ({ id: r.id, kind: r.kind as SlackCallKind, channelId: r.channel_id, channelName: r.channel_name, userName: r.user_name, text: r.text, ts: r.ts, permalink: r.permalink, seen: r.seen === 1, createdAt: r.created_at });

/** 글이 나를 부르는가. 직접 언급이 먼저다. */
export function slackCallKind(text: string, userId: string, channelKind: string): SlackCallKind | null {
  if (userId && text.includes(`<@${userId}>`)) return 'mention';
  if (/<!(here|channel|everyone)(\|[^>]*)?>/.test(text)) return 'here';
  if (channelKind === 'im' || channelKind === 'mpim') return 'dm';
  return null;
}

/**
 * 슬랙에서 나를 부른 글을 지켜본다: 나를 직접 언급한 글, 내가 든 채널의 @here·@channel·@everyone, 나에게 온 개인 메시지.
 * 에이전트 없이 두레가 정해진 것만 읽는다 (사용자가 설정에서 켠 것). 찾은 글은 적어 두고 'added' 로 알린다. 슬랙에 쓰지 않는다.
 *
 * 찾는 길이 둘이다:
 * - 검색 (search.messages 에 <@내id>): 스레드 안의 언급까지 한 번에 찾지만, 슬랙 문서가 보장하는 쓰임이 아니다. 안 되면 쉰다.
 * - 채널 훑기 (users.conversations + conversations.history): 문서에 있는 길. 내가 든 채널을 돌아가며 지난번 뒤의 글을 읽는다.
 *   한 번에 BUDGET 개만 읽으므로 채널이 많으면 조용한 채널의 글은 늦게 알게 된다. 스레드 안의 답글은 여기서 보이지 않는다.
 *
 * 켠 뒤의 글만 알린다 (지난 글을 거슬러 읽지 않는다).
 * 이벤트: 'changed' — 목록이나 상태가 바뀜, 'added' (SlackCall[]) — 새로 찾음
 */
export class SlackWatch extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running?: Promise<{ added: number }>;
  /** clear() 할 때마다 오른다: 도는 중이던 확인이 지워진 뒤에 다시 적지 않게 한다 */
  private gen = 0;

  constructor(private readonly d: {
    db: Database.Database;
    slack: { self(): Promise<SlackSelf | null>; status(): { connected: boolean } };
    settings: () => Settings;
    now?: () => number;
  }) { super(); }

  start(): void {
    const go = (): void => { void this.check().catch(() => { /* 다음 번에 다시 본다 */ }); };
    this.first = setTimeout(go, 20_000); this.first.unref?.();
    this.timer = setInterval(go, EVERY_MS); this.timer.unref?.();
  }
  dispose(): void { clearTimeout(this.first); clearInterval(this.timer); }

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private get(key: string): string { return (this.d.db.prepare('SELECT value FROM slack_watch_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? ''; }
  private set(key: string, value: string): void { this.d.db.prepare('INSERT INTO slack_watch_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

  status(): SlackWatchStatus {
    const n = (sql: string): number => (this.d.db.prepare(sql).get() as { n: number }).n;
    return {
      enabled: this.d.settings().slackWatch,
      connected: this.d.slack.status().connected,
      lastRunAt: Number(this.get('last_run')) || 0,
      lastError: this.get('last_error'),
      channels: n('SELECT COUNT(*) AS n FROM slack_watch_channels'),
      unseen: n('SELECT COUNT(*) AS n FROM slack_calls WHERE seen = 0'),
    };
  }

  calls(limit = 100): SlackCall[] {
    const max = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), KEEP);
    return (this.d.db.prepare('SELECT * FROM slack_calls ORDER BY CAST(ts AS REAL) DESC LIMIT ?').all(max) as CallRow[]).map(toCall);
  }

  /** 봤다고 적는다. ids 를 주지 않으면 전부 */
  seen(ids?: string[]): void {
    if (ids === undefined) this.d.db.prepare('UPDATE slack_calls SET seen = 1 WHERE seen = 0').run();
    else {
      const st = this.d.db.prepare('UPDATE slack_calls SET seen = 1 WHERE id = ?');
      for (const id of ids.slice(0, KEEP)) st.run(String(id));
    }
    this.emit('changed');
  }

  /** 지운다 (연결을 끊었을 때: 다른 계정의 글이 남지 않게). */
  clear(): void {
    this.gen += 1;
    this.d.db.exec('DELETE FROM slack_calls; DELETE FROM slack_watch_channels; DELETE FROM slack_watch_state;');
    this.emit('changed');
  }

  /** 지금부터 다시 본다 (껐다 켰을 때): 꺼 둔 동안의 글을 한꺼번에 알리지 않는다. */
  rebase(): void {
    const nowTs = (this.now() / 1000).toFixed(6);
    if (!this.get('since')) return;
    this.set('since', nowTs); this.set('search_ts', nowTs);
    this.d.db.prepare('UPDATE slack_watch_channels SET last_ts = ?').run(nowTs);
  }

  /** 한 번 확인한다. 꺼져 있거나 이미 도는 중이면 아무것도 하지 않는다. */
  check(): Promise<{ added: number }> {
    if (this.running) return this.running;
    if (!this.d.settings().slackWatch || this.now() - (Number(this.get('last_run')) || 0) < MIN_GAP_MS) return Promise.resolve({ added: 0 });
    this.running = this.run();
    return this.running;
  }

  private async run(): Promise<{ added: number }> {
    const found: SlackCall[] = [];
    let error = '';
    const gen = this.gen;
    try {
      const me = await this.d.slack.self();
      if (!me || !me.userId) { error = me ? '슬랙에서 내가 누구인지 알 수 없습니다.' : '슬랙이 연결돼 있지 않습니다 (설정 > 슬랙).'; return { added: 0 }; }
      // 계정이 바뀌었으면 처음부터: 앞 계정의 채널과 글을 섞지 않는다.
      if (this.get('user') !== me.userId) {
        this.d.db.exec('DELETE FROM slack_calls; DELETE FROM slack_watch_channels; DELETE FROM slack_watch_state;');
        this.set('user', me.userId);
      }
      const nowTs = (this.now() / 1000).toFixed(6);
      // 처음이면 지금부터 본다: 지난 글을 한꺼번에 알리지 않는다.
      if (!this.get('since')) { this.set('since', nowTs); this.set('search_ts', nowTs); }
      const stop = await this.search(me, found);
      if (stop) error = stop;
      else error = await this.sweep(me, nowTs, found);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.gen) { this.set('last_run', String(this.now())); this.set('last_error', oneLine(error, 300)); }
      this.d.db.prepare('DELETE FROM slack_calls WHERE id NOT IN (SELECT id FROM slack_calls ORDER BY created_at DESC, rowid DESC LIMIT ?)').run(KEEP);
      this.running = undefined;
      if (found.length) this.emit('added', found);
      this.emit('changed');
    }
    return { added: found.length };
  }

  /** 검색으로 나를 언급한 글을 찾는다. 멈춰야 하면(요청이 너무 잦다) 그 까닭을 돌려준다. */
  private async search(me: SlackSelf, found: SlackCall[]): Promise<string> {
    if (Number(this.get('search_off_until')) > this.now()) return '';
    let r: Record<string, unknown>;
    try {
      r = await me.call('search.messages', { query: `<@${me.userId}>`, sort: 'timestamp', sort_dir: 'desc', count: 20 });
    } catch (e) {
      if (codeOf(e) === 'ratelimited') return e instanceof Error ? e.message : '';
      // 검색이 안 되는 토큰(권한 없음, 봇 토큰)이다: 한동안 채널 훑기만으로 간다. 네트워크 문제면 다음에 다시 해 본다.
      if (codeOf(e)) this.set('search_off_until', String(this.now() + SEARCH_OFF_MS));
      return '';
    }
    const since = this.get('search_ts');
    const matches = (isObj(r.messages) && Array.isArray(r.messages.matches) ? r.messages.matches : []).filter(isObj);
    let newest = since;
    const gen = this.gen;
    for (const m of matches.reverse()) {
      if (gen !== this.gen) return '';
      const ts = String(m.ts ?? '');
      const ch = isObj(m.channel) ? m.channel : {};
      const channelId = String(ch.id ?? '');
      if (!TS.test(ts) || !CHANNEL_ID.test(channelId) || !after(ts, since)) continue;
      if (after(ts, newest)) newest = ts;
      const text = String(m.text ?? '');
      // 검색은 낱말로 찾으므로, 정말 나를 언급한 글인지 다시 본다.
      if (m.user === me.userId || !text.includes(`<@${me.userId}>`)) continue;
      const name = ch.is_im ? '개인 메시지' : oneLine(ch.name, 80) || channelId;
      const call = await this.add(me, { kind: 'mention', channelId, channelName: name, user: String(m.user ?? ''), fallbackUser: oneLine(m.username, 60), text, ts, permalink: String(m.permalink ?? '') });
      if (call) found.push(call);
    }
    if (newest !== since) this.set('search_ts', newest);
    return '';
  }

  /** 내가 든 채널을 돌아가며 읽는다. 문제가 있었으면 그 말을 돌려준다. */
  private async sweep(me: SlackSelf, nowTs: string, found: SlackCall[]): Promise<string> {
    if (Number(this.get('channels_at')) + CHANNELS_MS <= this.now()) {
      try { await this.refreshChannels(me, nowTs); } catch (e) { return e instanceof Error ? e.message : String(e); }
    }
    const dm = this.d.settings().slackWatchDm;
    const skip = new Set<string>(); // 권한이 없는 종류: 이번에는 더 읽지 않는다
    // 개인 메시지를 꺼 둔 동안의 글은 나중에 켜도 알리지 않는다.
    if (!dm) this.d.db.prepare("UPDATE slack_watch_channels SET last_ts = ? WHERE kind IN ('im','mpim')").run(nowTs);
    let error = '';
    const kinds = dm ? "('channel','private','mpim','im')" : "('channel','private')";
    const hot = this.d.db.prepare(`SELECT * FROM slack_watch_channels WHERE kind IN ${kinds} AND active_at > ? ORDER BY checked_at ASC LIMIT ?`).all(this.now() - HOT_MS, HOT) as ChannelRow[];
    const rest = (this.d.db.prepare(`SELECT * FROM slack_watch_channels WHERE kind IN ${kinds} ORDER BY checked_at ASC LIMIT ?`).all(BUDGET + HOT) as ChannelRow[])
      .filter((c) => !hot.some((h) => h.channel_id === c.channel_id)).slice(0, BUDGET - hot.length);
    const gen = this.gen;
    for (const c of [...hot, ...rest]) {
      if (gen !== this.gen) return ''; // 그사이 연결을 끊었다
      if (skip.has(c.kind)) continue;
      const got: Record<string, unknown>[] = [];
      try {
        // 새 글부터 온다. 밀린 글이 한 쪽을 넘으면 몇 쪽 더 읽는다.
        let cursor: string | undefined;
        for (let page = 0; page < PAGES; page += 1) {
          const r = await me.call('conversations.history', { channel: c.channel_id, oldest: c.last_ts, limit: 50, cursor });
          got.push(...(Array.isArray(r.messages) ? r.messages : []).filter(isObj));
          cursor = r.has_more === true && isObj(r.response_metadata) ? String(r.response_metadata.next_cursor ?? '') || undefined : undefined;
          if (!cursor) break;
        }
      } catch (e) {
        const code = codeOf(e);
        const text = e instanceof Error ? e.message : String(e);
        if (code === 'ratelimited') return text;
        if (code === 'channel_not_found' || code === 'not_in_channel' || code === 'is_archived') { this.d.db.prepare('DELETE FROM slack_watch_channels WHERE channel_id = ?').run(c.channel_id); continue; }
        // 이 종류는 읽을 권한이 없다: 이번에는 건너뛰고, 다음에도 앞자리를 차지하지 않게 뒤로 보낸다.
        if (code === 'missing_scope') { skip.add(c.kind); error = text; this.d.db.prepare('UPDATE slack_watch_channels SET checked_at = ? WHERE kind = ?').run(this.now(), c.kind); continue; }
        if (!code || ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired'].includes(code)) return text; // 네트워크나 토큰의 문제: 더 해 봐야 같다
        error = text;
        this.d.db.prepare('UPDATE slack_watch_channels SET checked_at = ? WHERE channel_id = ?').run(this.now(), c.channel_id);
        continue;
      }
      if (gen !== this.gen) return '';
      const messages = got.filter((m) => TS.test(String(m.ts ?? '')) && after(String(m.ts), c.last_ts));
      let last = c.last_ts;
      for (const m of messages.sort((a, b) => Number(a.ts) - Number(b.ts))) {
        const ts = String(m.ts);
        if (after(ts, last)) last = ts;
        if (m.user === me.userId || NOISE.has(String(m.subtype ?? ''))) continue;
        const text = String(m.text ?? '');
        const kind = slackCallKind(text, me.userId, c.kind);
        if (!kind) continue;
        // 개인 메시지의 이름은 보낸 사람으로 (목록을 받을 때 사람마다 이름을 묻지 않는다).
        const channelName = c.kind === 'im' && m.user ? `@${await me.userName(String(m.user))}` : c.name;
        const call = await this.add(me, { kind, channelId: c.channel_id, channelName, user: String(m.user ?? ''), fallbackUser: oneLine(m.username ?? (isObj(m.bot_profile) ? m.bot_profile.name : ''), 60), text, ts, permalink: '' });
        if (call) found.push(call);
      }
      this.d.db.prepare('UPDATE slack_watch_channels SET last_ts = ?, checked_at = ?, active_at = CASE WHEN ? THEN ? ELSE active_at END WHERE channel_id = ?')
        .run(last, this.now(), messages.length > 0 ? 1 : 0, this.now(), c.channel_id);
    }
    return error;
  }

  private async refreshChannels(me: SlackSelf, nowTs: string): Promise<void> {
    const seen = new Map<string, { name: string; kind: ChannelKind }>();
    let cursor: string | undefined;
    let whole = false;
    for (let page = 0; page < 10; page += 1) {
      const r = await me.call('users.conversations', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200, cursor });
      for (const c of (Array.isArray(r.channels) ? r.channels : []).filter(isObj)) {
        const id = String(c.id ?? '');
        if (!CHANNEL_ID.test(id)) continue;
        const kind: ChannelKind = c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private' : 'channel';
        const name = c.is_im ? '개인 메시지' : oneLine(c.name, 80) || id;
        seen.set(id, { name, kind });
      }
      cursor = isObj(r.response_metadata) ? String(r.response_metadata.next_cursor ?? '') || undefined : undefined;
      if (!cursor) { whole = true; break; }
    }
    // 처음 보는 채널은 지난번 목록을 받은 때부터 본다 (맨 처음에는 지켜보기를 켠 때부터): 새로 생긴 개인 메시지의 첫 글을 놓치지 않는다.
    const at = Number(this.get('channels_at'));
    const since = this.get('since');
    const prev = (at / 1000).toFixed(6);
    const fresh = at && after(prev, since) ? prev : since || nowTs;
    const put = this.d.db.prepare('INSERT INTO slack_watch_channels (channel_id, name, kind, last_ts) VALUES (?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name, kind = excluded.kind');
    this.d.db.transaction(() => {
      for (const [id, c] of seen) put.run(id, c.name, c.kind, fresh);
      // 목록을 끝까지 받았을 때만, 빠진 채널(나간 채널)을 지운다.
      if (whole) for (const row of this.d.db.prepare('SELECT channel_id FROM slack_watch_channels').all() as { channel_id: string }[]) if (!seen.has(row.channel_id)) this.d.db.prepare('DELETE FROM slack_watch_channels WHERE channel_id = ?').run(row.channel_id);
    })();
    this.set('channels_at', String(this.now()));
  }

  /** 적는다. 이미 적은 글이면 null (검색과 훑기가 같은 글을 찾을 수 있다). */
  private async add(me: SlackSelf, c: { kind: SlackCallKind; channelId: string; channelName: string; user: string; fallbackUser: string; text: string; ts: string; permalink: string }): Promise<SlackCall | null> {
    if (this.d.db.prepare('SELECT 1 FROM slack_calls WHERE channel_id = ? AND ts = ?').get(c.channelId, c.ts)) return null;
    const gen = this.gen;
    const userName = c.user ? await me.userName(c.user) : c.fallbackUser || '봇';
    // <!here> 같은 슬랙의 표기를 사람이 읽는 모양으로.
    const text = (await me.readable(c.text)).replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1').slice(0, MAX_TEXT);
    const [sec, frac = ''] = c.ts.split('.');
    const built = me.url ? `${me.url}archives/${c.channelId}/p${sec}${frac.padEnd(6, '0')}` : '';
    const permalink = PERMALINK.test(c.permalink) ? c.permalink : PERMALINK.test(built) ? built : '';
    if (gen !== this.gen) return null;
    const row: CallRow = { id: randomUUID(), kind: c.kind, channel_id: c.channelId, channel_name: c.channelName, user_name: oneLine(userName, 60), text, ts: c.ts, permalink, seen: 0, created_at: this.now() };
    const done = this.d.db.prepare('INSERT OR IGNORE INTO slack_calls (id, kind, channel_id, channel_name, user_name, text, ts, permalink, seen, created_at) VALUES (@id, @kind, @channel_id, @channel_name, @user_name, @text, @ts, @permalink, @seen, @created_at)').run(row);
    return done.changes ? toCall(row) : null;
  }
}
