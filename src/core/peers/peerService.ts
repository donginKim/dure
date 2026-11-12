import { EventEmitter } from 'node:events';
import { userInfo } from 'node:os';
import type Database from 'better-sqlite3';
import { parseRemoteRef, remoteLabel, remoteRef } from '@shared/remote';
import type {
  FoundPeer, HeldMessage, Message, Peer, PeerMode, PeerRequest, PeerStatus, RemoteWorkspace, Settings, Share, ShareInvite, SharingAudience, WorkspaceSharing,
} from '@shared/types';
import type { SecretBox } from '../dbService';
import { MAX_BODY, type MessageService } from '../messages';
import type { ProjectStore, WorkspaceStore } from '../stores';
import { fingerprint, generateKeys, open, pairingCode, seal, sharedKey, validPub, type Sealed } from './crypto';

/** 다른 두레와 실제로 주고받는 쪽. 앱에서는 HTTP 서버와 fetch 다. 시험에서는 메모리 안의 가짜를 쓴다 */
export interface PeerTransport {
  /** 듣기 시작한다. 실제로 연 포트를 돌려준다. handle: 받은 요청 (경로, 본문, 보낸 쪽의 호스트) → 응답 */
  listen(port: number, handle: (path: string, body: unknown, remoteHost: string) => Promise<unknown>): Promise<number>;
  close(): Promise<void>;
  /** 주소(호스트:포트)로 요청을 보내고 응답을 받는다. 닿지 않으면 던진다 */
  request(address: string, path: string, body: unknown): Promise<unknown>;
}

/** 같은 네트워크에서 서로 찾는 쪽 (앱에서는 Bonjour). */
export interface PeerDiscovery {
  start(me: { id: string; name: string; port: number }, onSeen: (p: { id: string; name: string; address: string }) => void, onGone: (id: string) => void): void;
  stop(): void;
}

interface PeerRow { id: string; name: string; pub: string; address: string; mode: string; direct: number; created_at: number }
interface ShareRow { id: string; name: string; owner_peer: string; project_id: string; created_at: number }
interface Envelope { v: 1; from: string; to: string; ts: number; nonce: string; box: string }
type Payload = { id: string; type: string; port?: number; name?: string } & Record<string, unknown>;
interface Pending { id: string; peerId: string; name: string; pub: string; address: string; direction: 'in' | 'out'; createdAt: number }
interface WireArtifact { kind: string; title: string; body: string }

const PROTOCOL = 1;
const CLOCK_SKEW_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 10;
const MAX_INVITES = 20;
const MAX_DIRECTORY = 100;
const MAX_ARTIFACTS = 5;
const MAX_ARTIFACT_BODY = 20_000;
/** 한 사람이 1분에 보낼 수 있는 메시지 수 */
const RATE_PER_MIN = 30;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
/** 사람과 워크스페이스의 이름에는 @ 를 쓰지 않는다 ("워크스페이스@사람" 으로 가리키기 때문이다). */
const cleanName = (s: unknown, fallback: string): string => oneLine(s, 40).replace(/[@"]/g, '') || fallback;
const isId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isAddress = (s: unknown): s is string => typeof s === 'string' && s.length <= 255 && /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/i.test(s);

export class PeerOfflineError extends Error {}

/**
 * 다른 사람의 두레와의 연결. 같은 네트워크에서 직접 주고받는다 (서버가 없다).
 * - 신원: 설치마다 id 와 열쇠 한 쌍. 연결(짝짓기)은 사용자가 확인 코드를 맞춰 보고 수락해야 된다.
 * - 그 뒤의 모든 내용은 두 사람의 공유 열쇠로 감싼다. 풀리지 않는 것, 오래된 것, 되풀이된 것은 버린다.
 * - 함께하는 프로젝트: 한 사람이 열고 초대한다. 참여자 목록은 연 사람이 나눠 준다.
 * - 공개 범위: 워크스페이스마다. 공개하지 않은 워크스페이스는 이름도 나가지 않고 메시지도 받지 않는다.
 * - 받은 메시지는 그 사람의 받는 방식에 따라 바로 전달하거나, 사용자가 넘겨줄 때까지 붙잡아 둔다.
 * 이벤트: 'changed' — 화면이 다시 읽어야 할 때
 */
export class PeerService extends EventEmitter {
  private port: number | null = null;
  private error: string | undefined;
  private applying: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();
  private readonly invites = new Map<string, ShareInvite>();
  private readonly seen = new Map<string, { name: string; address: string }>();
  private readonly replay = new Map<string, number>();
  private readonly rate = new Map<string, number[]>();
  private readonly keys = new Map<string, Buffer>();
  private publishTimer: NodeJS.Timeout | undefined;
  private readonly handlers = new Map<string, (peer: { id: string; name: string }, payload: Record<string, unknown>, projectId: string) => unknown>();

  constructor(private readonly d: {
    db: Database.Database; projects: ProjectStore; workspaces: WorkspaceStore; messages: MessageService;
    settings(): Settings; secrets: SecretBox; transport: PeerTransport; discovery?: PeerDiscovery;
    isProjectClosed(projectId: string): boolean;
  }) {
    super();
    d.messages.useRemoteNames((ref) => this.nameOf(ref));
  }

  // ---- 신원 ----

  private get(k: string): string | undefined {
    return (this.d.db.prepare('SELECT v FROM peer_identity WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  }

  private set(k: string, v: string): void {
    this.d.db.prepare('INSERT INTO peer_identity (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  /** 내 id 와 열쇠. 처음 쓸 때 만든다. 비밀 열쇠는 암호화해 둔다. */
  private me(): { id: string; pub: string; priv: string } {
    let id = this.get('id');
    let pub = this.get('pub');
    const stored = this.get('priv');
    if (id && pub && stored) return { id, pub, priv: this.d.secrets.decrypt(stored) };
    const keys = generateKeys();
    id = crypto.randomUUID();
    pub = keys.pub;
    // 암호화할 수 없는 환경이면 여기서 던진다: 열쇠를 그대로 적어 두지 않는다.
    const sealed = this.d.secrets.encrypt(keys.priv);
    this.d.db.transaction(() => { this.set('id', id!); this.set('pub', pub!); this.set('priv', sealed); })();
    return { id, pub, priv: keys.priv };
  }

  private myName(): string {
    let fallback = '두레 사용자';
    try { fallback = userInfo().username || fallback; } catch { /* 이름을 알 수 없음 */ }
    return cleanName(this.d.settings().peerName, cleanName(fallback, '두레 사용자'));
  }

  status(): PeerStatus {
    const enabled = this.d.settings().peersEnabled;
    try {
      const me = this.me();
      return { enabled, id: me.id, name: this.myName(), fingerprint: fingerprint(me.pub), port: this.port, error: this.error };
    } catch (e) {
      return { enabled, id: '', name: this.myName(), fingerprint: '', port: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 설정에 맞춰 듣기를 켜거나 끈다. 설정이 바뀔 때와 시작할 때 부른다. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow()).catch(() => undefined);
    return this.applying;
  }

  private async applyNow(): Promise<void> {
    const s = this.d.settings();
    const want = s.peersEnabled ? s.peerPort : null;
    if (want === null) {
      if (this.port !== null) { this.d.discovery?.stop(); await this.d.transport.close().catch(() => undefined); }
      this.port = null; this.error = undefined; this.seen.clear();
      this.emit('changed');
      return;
    }
    try {
      const me = this.me();
      if (this.port !== null) { this.d.discovery?.stop(); await this.d.transport.close().catch(() => undefined); this.port = null; }
      this.port = await this.d.transport.listen(want, (path, body, host) => this.handle(path, body, host));
      this.error = undefined;
      this.d.discovery?.start({ id: me.id, name: this.myName(), port: this.port }, (p) => this.onSeen(p), (id) => { if (this.seen.delete(id)) this.emit('changed'); });
      this.publishSoon();
    } catch (e) {
      this.port = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.emit('changed');
  }

  async dispose(): Promise<void> {
    clearTimeout(this.publishTimer);
    this.d.discovery?.stop();
    await this.d.transport.close().catch(() => undefined);
    this.port = null;
  }

  private mustBeOn(): void {
    if (this.port === null) throw new Error(this.error ? `다른 사람과 연결할 수 없습니다: ${this.error}` : '설정에서 "다른 사람과 연결" 을 켜야 합니다.');
  }

  // ---- 찾기 ----

  private onSeen(p: { id: string; name: string; address: string }): void {
    if (!isId(p.id) || !isAddress(p.address) || p.id === this.get('id')) return;
    this.seen.set(p.id, { name: cleanName(p.name, '이름 없음'), address: p.address });
    // 이미 아는 사람이면 주소를 따라간다 (같은 네트워크에서 주소가 바뀔 수 있다).
    const known = this.peerRow(p.id);
    if (known && known.address !== p.address) this.d.db.prepare('UPDATE peers SET address = ? WHERE id = ?').run(p.address, p.id);
    if (known) this.publishSoon();
    this.emit('changed');
  }

  /** 같은 네트워크에서 보이는 두레. */
  found(): FoundPeer[] {
    return [...this.seen.entries()].map(([peerId, v]) => ({ peerId, name: v.name, address: v.address, known: this.peerRow(peerId)?.direct === 1 }));
  }

  // ---- 사람 ----

  private peerRow(id: string): PeerRow | undefined {
    return this.d.db.prepare('SELECT * FROM peers WHERE id = ?').get(id) as PeerRow | undefined;
  }

  private toPeer(r: PeerRow): Peer {
    return { id: r.id, name: r.name, fingerprint: fingerprint(r.pub), address: r.address, mode: r.mode === 'direct' ? 'direct' : 'review', direct: r.direct === 1, online: this.seen.has(r.id), createdAt: r.created_at };
  }

  peers(): Peer[] {
    return (this.d.db.prepare('SELECT * FROM peers ORDER BY created_at').all() as PeerRow[]).map((r) => this.toPeer(r));
  }

  setMode(peerId: string, mode: PeerMode): void {
    if (mode !== 'review' && mode !== 'direct') throw new Error('받는 방식이 올바르지 않습니다.');
    if (!this.peerRow(peerId)) throw new Error('연결된 사람이 아닙니다.');
    this.d.db.prepare('UPDATE peers SET mode = ? WHERE id = ?').run(mode, peerId);
    this.emit('changed');
  }

  /** 연결을 끊는다. 그 사람이 연 프로젝트에서는 나가고, 내가 연 프로젝트에서는 그 사람을 뺀다. */
  async removePeer(peerId: string): Promise<void> {
    if (!this.peerRow(peerId)) throw new Error('연결된 사람이 아닙니다.');
    for (const s of this.d.db.prepare('SELECT * FROM shares').all() as ShareRow[]) {
      if (s.owner_peer === peerId) await this.leave(s.project_id).catch(() => undefined);
      else if (this.isMine(s) && this.memberIds(s.id).includes(peerId)) await this.removeMember(s.id, peerId).catch(() => undefined);
    }
    this.d.db.prepare('DELETE FROM peers WHERE id = ?').run(peerId);
    this.keys.delete(peerId);
    this.emit('changed');
  }

  private upsertPeer(p: { id: string; name: string; pub: string; address: string }, direct: boolean): void {
    const old = this.peerRow(p.id);
    if (old) {
      // 열쇠가 바뀌면 받는 방식을 처음으로 되돌린다: 다른 사람(또는 다시 깐 두레)일 수 있다.
      const mode = old.pub === p.pub ? old.mode : 'review';
      this.d.db.prepare('UPDATE peers SET name = ?, pub = ?, address = ?, mode = ?, direct = MAX(direct, ?) WHERE id = ?')
        .run(p.name, p.pub, p.address || old.address, mode, direct ? 1 : 0, p.id);
    } else {
      this.d.db.prepare('INSERT INTO peers (id, name, pub, address, mode, direct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.id, p.name, p.pub, p.address, 'review', direct ? 1 : 0, Date.now());
    }
    this.keys.delete(p.id);
  }

  // ---- 감싸서 보내기 ----

  private keyFor(peerId: string, pub: string): Buffer {
    const cached = this.keys.get(peerId);
    if (cached) return cached;
    const me = this.me();
    const key = sharedKey(me.priv, pub, me.pub);
    this.keys.set(peerId, key);
    return key;
  }

  private async sendTo(to: { id: string; pub: string; address: string }, payload: Omit<Payload, 'id' | 'port' | 'name'>): Promise<Record<string, unknown>> {
    this.mustBeOn();
    if (!to.address) throw new PeerOfflineError('그 사람의 주소를 모릅니다.');
    const me = this.me();
    const ts = Date.now();
    const inner: Payload = { ...payload, id: crypto.randomUUID(), type: String(payload.type), port: this.port ?? undefined, name: this.myName() };
    // 다른 사람의 열쇠를 쓰는 경우(짝짓기 수락)가 있어 캐시를 거치지 않을 수 있다.
    const key = this.peerRow(to.id)?.pub === to.pub ? this.keyFor(to.id, to.pub) : sharedKey(me.priv, to.pub, me.pub);
    const sealed = seal(key, JSON.stringify(inner), `${me.id}|${to.id}|${ts}`);
    const env: Envelope = { v: PROTOCOL, from: me.id, to: to.id, ts, ...sealed };
    let res: unknown;
    try {
      res = await this.d.transport.request(to.address, 'msg', env);
    } catch {
      throw new PeerOfflineError('그 사람의 두레에 닿지 않습니다 (꺼져 있거나 같은 네트워크가 아닙니다).');
    }
    const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
    if (r.ok !== true) throw new Error(typeof r.error === 'string' ? `상대가 받지 않았습니다: ${oneLine(r.error, 200)}` : '상대가 받지 않았습니다.');
    return r;
  }

  private sendPeer(peerId: string, payload: Omit<Payload, 'id' | 'port' | 'name'>): Promise<Record<string, unknown>> {
    const r = this.peerRow(peerId);
    if (!r) throw new Error('연결된 사람이 아닙니다.');
    return this.sendTo(r, payload);
  }

  // ---- 연결 (짝짓기) ----

  private prune(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    for (const [id, at] of this.replay) if (now - at > 2 * CLOCK_SKEW_MS) this.replay.delete(id);
  }

  private toRequest(p: Pending): PeerRequest {
    const me = this.me();
    const known = this.peerRow(p.peerId);
    return {
      id: p.id, peerId: p.peerId, name: p.name, address: p.address, fingerprint: fingerprint(p.pub), code: pairingCode(me.pub, p.pub),
      direction: p.direction, keyChanged: known !== undefined && known.pub !== p.pub, createdAt: p.createdAt,
    };
  }

  requests(): PeerRequest[] {
    this.prune();
    return [...this.pending.values()].map((p) => this.toRequest(p));
  }

  /** 주소(호스트:포트)의 두레에 연결을 요청한다. 상대가 수락해야 연결된다. */
  async connect(address: string): Promise<PeerRequest> {
    this.mustBeOn();
    const target = String(address ?? '').trim();
    if (!isAddress(target)) throw new Error('주소는 "호스트:포트" 로 적으세요 (예: 192.168.0.12:47800).');
    const me = this.me();
    let hello: Record<string, unknown>;
    try {
      hello = ((await this.d.transport.request(target, 'hello', {})) ?? {}) as Record<string, unknown>;
    } catch {
      throw new PeerOfflineError('그 주소의 두레에 닿지 않습니다. 상대가 "다른 사람과 연결" 을 켰는지, 같은 네트워크인지 확인하세요.');
    }
    if (hello.v !== PROTOCOL || !isId(hello.id) || !validPub(hello.pub)) throw new Error('그 주소에 있는 것이 두레가 아니거나 판이 맞지 않습니다.');
    if (hello.id === me.id) throw new Error('내 두레의 주소입니다.');
    this.prune();
    for (const [id, p] of this.pending) if (p.peerId === hello.id && p.direction === 'out') this.pending.delete(id);
    const pending: Pending = { id: crypto.randomUUID(), peerId: hello.id, name: cleanName(hello.name, '이름 없음'), pub: hello.pub, address: target, direction: 'out', createdAt: Date.now() };
    try {
      await this.d.transport.request(target, 'pair', { v: PROTOCOL, id: me.id, name: this.myName(), pub: me.pub, port: this.port });
    } catch {
      throw new PeerOfflineError('연결 요청을 보내지 못했습니다.');
    }
    this.pending.set(pending.id, pending);
    this.emit('changed');
    return this.toRequest(pending);
  }

  /** 받은 연결 요청을 수락한다. 확인 코드를 상대와 맞춰 본 뒤에 눌러야 한다. */
  async accept(requestId: string): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p || p.direction !== 'in') throw new Error('수락할 요청이 아닙니다.');
    // 먼저 알린다: 상대에게 닿지 않으면 연결하지 않는다 (한쪽만 연결된 상태가 되지 않게).
    await this.sendTo({ id: p.peerId, pub: p.pub, address: p.address }, { type: 'pair.accept' });
    this.upsertPeer({ id: p.peerId, name: p.name, pub: p.pub, address: p.address }, true);
    this.pending.delete(requestId);
    this.emit('changed');
  }

  /** 받은 요청을 거절하거나, 보낸 요청을 거둔다. */
  dismiss(requestId: string): void {
    if (this.pending.delete(requestId)) this.emit('changed');
  }

  // ---- 함께하는 프로젝트 ----

  private isMine(s: ShareRow): boolean { return s.owner_peer === this.get('id'); }
  private shareRow(id: string): ShareRow | undefined { return this.d.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined; }
  private shareOfProject(projectId: string): ShareRow | undefined { return this.d.db.prepare('SELECT * FROM shares WHERE project_id = ?').get(projectId) as ShareRow | undefined; }
  /** 참여한 사람들의 id (나 빼고, 초대만 한 사람 빼고). */
  private memberIds(shareId: string): string[] {
    return (this.d.db.prepare("SELECT peer_id FROM share_members WHERE share_id = ? AND state = 'member'").all(shareId) as { peer_id: string }[]).map((r) => r.peer_id);
  }

  private toShare(s: ShareRow): Share {
    const me = this.me();
    const mine = s.owner_peer === me.id;
    return {
      id: s.id, name: s.name, projectId: s.project_id, ownerPeerId: s.owner_peer, mine,
      members: [
        { peerId: me.id, name: this.myName(), me: true, owner: mine, online: true },
        ...this.memberIds(s.id).map((id) => ({ peerId: id, name: this.peerRow(id)?.name ?? '알 수 없는 사람', me: false, owner: id === s.owner_peer, online: this.seen.has(id) })),
      ],
    };
  }

  share(projectId: string): Share | null {
    const s = this.shareOfProject(projectId);
    return s ? this.toShare(s) : null;
  }

  /** 내 프로젝트를 함께하는 프로젝트로 연다. */
  createShare(projectId: string): Share {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error('프로젝트가 없습니다.');
    if (this.d.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다.');
    if (this.shareOfProject(projectId)) throw new Error('이미 함께하는 프로젝트입니다.');
    const me = this.me();
    const id = crypto.randomUUID();
    this.d.db.prepare('INSERT INTO shares (id, name, owner_peer, project_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, cleanName(project.name, '프로젝트'), me.id, projectId, Date.now());
    this.emit('changed');
    return this.toShare(this.shareRow(id)!);
  }

  /** 연결된 사람을 초대한다. 프로젝트를 연 사람만 할 수 있다. */
  async invite(shareId: string, peerId: string): Promise<void> {
    const s = this.shareRow(shareId);
    if (!s || !this.isMine(s)) throw new Error('내가 연 프로젝트가 아닙니다.');
    const peer = this.peerRow(peerId);
    if (!peer || peer.direct !== 1) throw new Error('직접 연결한 사람만 초대할 수 있습니다.');
    if (this.memberIds(shareId).includes(peerId)) throw new Error('이미 참여한 사람입니다.');
    await this.sendPeer(peerId, { type: 'share.invite', share: { id: s.id, name: s.name } });
    this.d.db.prepare("INSERT INTO share_members (share_id, peer_id, state) VALUES (?, ?, 'invited') ON CONFLICT DO NOTHING").run(shareId, peerId);
    this.emit('changed');
  }

  shareInvites(): ShareInvite[] { return [...this.invites.values()]; }

  /** 초대를 받아들인다: 내 프로젝트 하나에 이어 붙인다. */
  async acceptInvite(inviteId: string, projectId: string): Promise<Share> {
    const inv = this.invites.get(inviteId);
    if (!inv) throw new Error('받은 초대가 아닙니다.');
    if (!this.d.projects.get(projectId)) throw new Error('프로젝트가 없습니다.');
    if (this.d.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다.');
    if (this.shareOfProject(projectId)) throw new Error('그 프로젝트는 이미 함께하는 프로젝트입니다. 다른 프로젝트를 고르세요.');
    if (this.shareRow(inv.shareId)) throw new Error('이미 참여한 프로젝트입니다.');
    // 내 쪽 기록을 먼저 만든다: 참여를 알리자마자 연 사람이 참여자 목록을 보내오는데, 그때 이 기록이 있어야 받는다.
    this.d.db.transaction(() => {
      this.d.db.prepare('INSERT INTO shares (id, name, owner_peer, project_id, created_at) VALUES (?, ?, ?, ?, ?)').run(inv.shareId, inv.name, inv.fromPeerId, projectId, Date.now());
      this.d.db.prepare("INSERT INTO share_members (share_id, peer_id, state) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING").run(inv.shareId, inv.fromPeerId);
    })();
    try {
      await this.sendPeer(inv.fromPeerId, { type: 'share.join', shareId: inv.shareId });
    } catch (e) {
      // 연 사람에게 닿지 않았으면 참여하지 않은 것으로 되돌린다.
      this.d.db.prepare('DELETE FROM shares WHERE id = ?').run(inv.shareId);
      throw e;
    }
    this.invites.delete(inviteId);
    this.emit('changed');
    this.publishSoon();
    return this.toShare(this.shareRow(inv.shareId)!);
  }

  declineInvite(inviteId: string): void {
    if (this.invites.delete(inviteId)) this.emit('changed');
  }

  private dropShare(shareId: string): void {
    const s = this.shareRow(shareId);
    if (!s) return;
    this.d.db.transaction(() => {
      this.d.db.prepare('DELETE FROM workspace_sharing WHERE workspace_id IN (SELECT id FROM workspaces WHERE project_id = ?)').run(s.project_id);
      this.d.db.prepare('DELETE FROM shares WHERE id = ?').run(shareId);
    })();
    this.emit('changed');
  }

  /** 함께하기를 그만둔다. 내가 연 것이면 닫고 참여자에게 알린다. 프로젝트 자체는 그대로다. */
  async leave(projectId: string): Promise<void> {
    const s = this.shareOfProject(projectId);
    if (!s) throw new Error('함께하는 프로젝트가 아닙니다.');
    // 알리지 못해도 그만둔다: 상대가 꺼져 있다고 못 나가면 안 된다.
    if (this.isMine(s)) await Promise.all(this.memberIds(s.id).map((id) => this.sendPeer(id, { type: 'share.closed', shareId: s.id }).catch(() => undefined)));
    else await this.sendPeer(s.owner_peer, { type: 'share.leave', shareId: s.id }).catch(() => undefined);
    this.dropShare(s.id);
  }

  /** 참여자를 뺀다. 프로젝트를 연 사람만 할 수 있다. */
  async removeMember(shareId: string, peerId: string): Promise<void> {
    const s = this.shareRow(shareId);
    if (!s || !this.isMine(s)) throw new Error('내가 연 프로젝트가 아닙니다.');
    this.d.db.transaction(() => {
      this.d.db.prepare('DELETE FROM share_members WHERE share_id = ? AND peer_id = ?').run(shareId, peerId);
      this.d.db.prepare('DELETE FROM remote_workspaces WHERE share_id = ? AND peer_id = ?').run(shareId, peerId);
    })();
    await this.sendPeer(peerId, { type: 'share.removed', shareId }).catch(() => undefined);
    await this.broadcastMembers(s);
    this.emit('changed');
  }

  /** 참여자 목록을 모두에게 나눠 준다 (연 사람만). 참여자끼리는 이 목록의 열쇠로 서로를 안다. */
  private async broadcastMembers(s: ShareRow): Promise<void> {
    const me = this.me();
    const ids = this.memberIds(s.id);
    const members = [
      { id: me.id, name: this.myName(), pub: me.pub, address: '' },
      ...ids.map((id) => this.peerRow(id)).filter((r): r is PeerRow => r !== undefined).map((r) => ({ id: r.id, name: r.name, pub: r.pub, address: r.address })),
    ];
    await Promise.all(ids.map((id) => this.sendPeer(id, { type: 'share.members', shareId: s.id, shareName: s.name, members }).catch(() => undefined)));
  }

  // ---- 공개 범위 ----

  sharing(workspaceId: string): WorkspaceSharing {
    const r = this.d.db.prepare('SELECT * FROM workspace_sharing WHERE workspace_id = ?').get(workspaceId) as { audience: string; peers: string } | undefined;
    let peers: string[] = [];
    try { peers = (JSON.parse(r?.peers ?? '[]') as unknown[]).filter(isId); } catch { /* 비어 있는 것으로 */ }
    const audience: SharingAudience = r?.audience === 'all' ? 'all' : r?.audience === 'selected' ? 'selected' : 'none';
    return { workspaceId, audience, peers };
  }

  /**
   * 다른 기능이 함께하는 사람과 주고받을 것을 얹는다 (배정 등). 받은 것은 그 프로젝트의 참여자가 보낸 것일 때만 넘어온다.
   * handler 가 돌려준 값이 상대에게 가는 응답이다 (없으면 { ok: true }).
   */
  on2(type: string, handler: (peer: { id: string; name: string }, payload: Record<string, unknown>, projectId: string) => unknown): void {
    this.handlers.set(type, handler);
  }

  /** 함께하는 사람들 (나 빼고). */
  people(projectId: string): { peerId: string; name: string; online: boolean }[] {
    const s = this.shareOfProject(projectId);
    return s ? this.memberIds(s.id).map((id) => ({ peerId: id, name: this.peerRow(id)?.name ?? '알 수 없는 사람', online: this.seen.has(id) })).sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.peerId.localeCompare(b.peerId)) : [];
  }

  /** 함께하는 사람 한 명에게 보낸다. 닿지 않으면 던진다. */
  async sendMember(projectId: string, peerId: string, payload: { type: string } & Record<string, unknown>): Promise<void> {
    const s = this.shareOfProject(projectId);
    if (!s || !this.memberIds(s.id).includes(peerId)) throw new Error('함께하는 사람이 아닙니다.');
    await this.sendPeer(peerId, { ...payload, shareId: s.id });
  }

  /** 이 워크스페이스를 그 사람에게도 보이게 한다 (이미 보이면 그대로). */
  allow(workspaceId: string, peerId: string): void {
    if (this.visibleTo(workspaceId, peerId)) return;
    const sh = this.sharing(workspaceId);
    this.setSharing(workspaceId, 'selected', [...sh.peers, peerId]);
  }

  /** 워크스페이스를 누구에게 보일지 정한다. 기본은 아무에게도 보이지 않는다. */
  setSharing(workspaceId: string, audience: SharingAudience, peers: string[] = []): WorkspaceSharing {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error('공개할 수 있는 워크스페이스가 아닙니다.');
    const s = this.shareOfProject(ws.projectId);
    if (!s) throw new Error('먼저 이 프로젝트를 함께하는 프로젝트로 열거나 초대를 받아야 합니다.');
    if (audience !== 'none' && audience !== 'all' && audience !== 'selected') throw new Error('공개 범위가 올바르지 않습니다.');
    const members = this.memberIds(s.id);
    const chosen = audience === 'selected' ? [...new Set((Array.isArray(peers) ? peers : []).filter((p) => members.includes(p)))] : [];
    if (audience === 'none') this.d.db.prepare('DELETE FROM workspace_sharing WHERE workspace_id = ?').run(workspaceId);
    else this.d.db.prepare('INSERT INTO workspace_sharing (workspace_id, audience, peers) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET audience = excluded.audience, peers = excluded.peers').run(workspaceId, audience, JSON.stringify(chosen));
    this.emit('changed');
    this.publishSoon();
    return this.sharing(workspaceId);
  }

  /** 이 워크스페이스가 그 사람에게 보이는가. */
  visibleTo(workspaceId: string, peerId: string): boolean {
    const sh = this.sharing(workspaceId);
    return sh.audience === 'all' || (sh.audience === 'selected' && sh.peers.includes(peerId));
  }

  /** 공개한 워크스페이스의 목록을 참여자에게 보낸다. 사람마다 그 사람에게 보이는 것만 간다. */
  publishSoon(): void {
    clearTimeout(this.publishTimer);
    if (this.port === null) return;
    this.publishTimer = setTimeout(() => { void this.publishNow(); }, 250);
    this.publishTimer.unref?.();
  }

  async publishNow(): Promise<void> {
    if (this.port === null) return;
    for (const s of this.d.db.prepare('SELECT * FROM shares').all() as ShareRow[]) {
      // 조율 에이전트도 공개돼 있으면 목록에 들어간다 (일을 나눠 받은 사람의 에이전트가 보고할 곳이다).
      const mine = this.d.workspaces.listAll(s.project_id);
      await Promise.all(this.memberIds(s.id).map((peerId) => this.sendPeer(peerId, {
        type: 'directory', shareId: s.id,
        workspaces: mine.filter((w) => this.visibleTo(w.id, peerId)).slice(0, MAX_DIRECTORY).map((w) => ({ id: w.id, name: cleanName(w.name, '워크스페이스') })),
      }).catch(() => undefined)));
    }
  }

  /** 다른 사람이 나에게 공개한 워크스페이스. */
  remoteWorkspaces(projectId: string): RemoteWorkspace[] {
    const s = this.shareOfProject(projectId);
    if (!s) return [];
    const members = new Set(this.memberIds(s.id));
    const rows = this.d.db.prepare('SELECT * FROM remote_workspaces WHERE share_id = ? AND listed = 1 ORDER BY peer_id, name').all(s.id) as { peer_id: string; workspace_id: string; name: string }[];
    return rows.filter((r) => members.has(r.peer_id)).map((r) => {
      const peerName = this.peerRow(r.peer_id)?.name ?? '알 수 없는 사람';
      return { ref: remoteRef(r.peer_id, r.workspace_id), shareId: s.id, projectId, peerId: r.peer_id, peerName, name: r.name, label: remoteLabel(r.name, peerName) };
    });
  }

  /** 화면이 메시지의 보낸 쪽·받는 쪽을 보여 줄 때 쓰는 이름표: ref → "워크스페이스@사람". 목록에서 빠진 것도 들어 있다. */
  remoteNames(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.d.db.prepare('SELECT peer_id, workspace_id, name FROM remote_workspaces').all() as { peer_id: string; workspace_id: string; name: string }[]) {
      out[remoteRef(r.peer_id, r.workspace_id)] = remoteLabel(r.name, this.peerRow(r.peer_id)?.name ?? '알 수 없는 사람');
    }
    return out;
  }

  /** 다른 사람의 워크스페이스의 이름과 주인. 메시지를 보여 줄 때 쓴다. */
  nameOf(ref: string): { name: string; owner: string } | undefined {
    const p = parseRemoteRef(ref);
    if (!p) return undefined;
    const row = this.d.db.prepare('SELECT name FROM remote_workspaces WHERE peer_id = ? AND workspace_id = ? LIMIT 1').get(p.peerId, p.workspaceId) as { name: string } | undefined;
    const peer = this.peerRow(p.peerId);
    return row || peer ? { name: row?.name ?? '알 수 없는 워크스페이스', owner: peer?.name ?? '알 수 없는 사람' } : undefined;
  }

  // ---- 메시지 ----

  /**
   * 내 워크스페이스의 에이전트가 다른 사람의 워크스페이스에 메시지를 보낸다.
   * 보내는 워크스페이스가 그 사람에게 공개돼 있어야 한다: 무엇이 밖으로 나가는지는 사용자가 정한다.
   */
  async sendRemote(i: { fromWorkspaceId: string; to: string; body: string; threadId?: string; artifactIds?: string[] }): Promise<Message> {
    const ws = this.d.workspaces.get(i.fromWorkspaceId);
    if (!ws) throw new Error('워크스페이스가 없다.');
    if (this.d.isProjectClosed(ws.projectId)) throw new Error('완료된 프로젝트다.');
    const s = this.shareOfProject(ws.projectId);
    const all = s ? this.remoteWorkspaces(ws.projectId) : [];
    const matches = all.filter((r) => r.label === i.to.trim());
    if (matches.length === 0) throw new Error(`"${i.to}" 라는 다른 사람의 워크스페이스가 없다. 보이는 것: ${all.map((r) => `"${r.label}"`).join(', ') || '(없음)'}`);
    if (matches.length > 1) throw new Error(`"${i.to}" 가 둘 이상이라 받는 쪽을 정할 수 없다. 사용자에게 알려라.`);
    const target = matches[0]!;
    if (!this.visibleTo(ws.id, target.peerId)) throw new Error(`이 워크스페이스는 ${target.peerName} 에게 공개돼 있지 않아 메시지를 보낼 수 없다. 필요하면 사용자에게 두레에서 이 워크스페이스를 공개해 달라고 하라.`);
    const body = String(i.body ?? '').trim();
    if (!body) throw new Error('메시지 내용을 입력하세요.');
    if (body.length > MAX_BODY) throw new Error(`메시지가 너무 깁니다 (최대 ${MAX_BODY}자).`);
    const ids = (i.artifactIds ?? []).slice(0, MAX_ARTIFACTS);
    const artifacts: WireArtifact[] = ids.map((id) => {
      const a = this.d.messages.artifact(id);
      if (!a || a.projectId !== ws.projectId) throw new Error(`이 프로젝트의 자료가 아닙니다: ${id}`);
      // 파일은 보내지 않는다: 글만 보낸다.
      return { kind: a.kind, title: a.title, body: a.body ? a.body.slice(0, MAX_ARTIFACT_BODY) : '(파일로 된 자료다. 파일은 보내지 않았다. 필요하면 내용을 글로 보내 달라고 하라)' };
    });
    if (i.threadId) {
      const t = this.d.messages.thread(i.threadId);
      if (!t || t.projectId !== ws.projectId) throw new Error('이 프로젝트의 스레드가 아닙니다.');
    }
    const threadId = i.threadId ?? crypto.randomUUID();
    const parsed = parseRemoteRef(target.ref)!;
    await this.sendPeer(target.peerId, { type: 'message', shareId: s!.id, from: { id: ws.id, name: cleanName(ws.name, '워크스페이스') }, to: parsed.workspaceId, body, thread: threadId, artifacts });
    // 보낸 뒤에 기록한다: 닿지 않았으면 보낸 것으로 남지 않는다.
    return this.d.messages.send({ projectId: ws.projectId, from: { kind: 'workspace', workspaceId: ws.id }, toWorkspaceId: target.ref, body, threadId, createThread: true, artifactIds: ids });
  }

  private toHeld(r: { id: string; share_id: string; from_peer: string; from_workspace: string; to_workspace_id: string; body: string; artifacts: string; created_at: number }): HeldMessage | null {
    const s = this.shareRow(r.share_id);
    if (!s) return null;
    const ref = remoteRef(r.from_peer, r.from_workspace);
    const n = this.nameOf(ref);
    let artifacts: WireArtifact[] = [];
    try { artifacts = JSON.parse(r.artifacts) as WireArtifact[]; } catch { /* 없음 */ }
    return { id: r.id, projectId: s.project_id, fromRef: ref, fromLabel: n ? remoteLabel(n.name, n.owner) : '알 수 없는 워크스페이스', toWorkspaceId: r.to_workspace_id, body: r.body, artifacts, createdAt: r.created_at };
  }

  /** 다른 사람의 에이전트가 보낸 메시지 중, 내가 넘겨주기를 기다리는 것. */
  held(projectId: string): HeldMessage[] {
    const s = this.shareOfProject(projectId);
    if (!s) return [];
    return (this.d.db.prepare('SELECT * FROM peer_inbox WHERE share_id = ? ORDER BY created_at').all(s.id) as Parameters<PeerService['toHeld']>[0][])
      .map((r) => this.toHeld(r)).filter((h): h is HeldMessage => h !== null);
  }

  /** 붙잡아 둔 메시지를 내 에이전트에게 넘겨준다. */
  pass(heldId: string): void {
    const r = this.d.db.prepare('SELECT * FROM peer_inbox WHERE id = ?').get(heldId) as (Parameters<PeerService['toHeld']>[0] & { thread: string }) | undefined;
    const h = r && this.toHeld(r);
    if (!r || !h) throw new Error('기다리는 메시지가 아닙니다.');
    this.deliver({ projectId: h.projectId, fromRef: h.fromRef, toWorkspaceId: h.toWorkspaceId, body: h.body, thread: r.thread, artifacts: h.artifacts });
    this.d.db.prepare('DELETE FROM peer_inbox WHERE id = ?').run(heldId);
    this.emit('changed');
  }

  /** 붙잡아 둔 메시지를 버린다. 내 에이전트에게 가지 않는다. */
  drop(heldId: string): void {
    this.d.db.prepare('DELETE FROM peer_inbox WHERE id = ?').run(heldId);
    this.emit('changed');
  }

  /** 받은 메시지를 내 워크스페이스에 전달한다 (기록하고, 전달 엔진이 에이전트를 깨운다). */
  private deliver(m: { projectId: string; fromRef: string; toWorkspaceId: string; body: string; thread: string; artifacts: WireArtifact[] }): void {
    const artifactIds = m.artifacts.map((a) => this.d.messages.publish({
      projectId: m.projectId, workspaceId: m.fromRef, kind: (['result', 'decision', 'api-spec', 'note'] as const).find((k) => k === a.kind) ?? 'note', title: a.title, body: a.body || '(내용 없음)',
    }).id);
    // 같은 스레드 id 를 쓴다. 그 id 가 내 다른 프로젝트의 스레드면 새 스레드로 받는다.
    const existing = this.d.messages.thread(m.thread);
    const threadId = existing && existing.projectId !== m.projectId ? undefined : m.thread;
    this.d.messages.send({ projectId: m.projectId, from: { kind: 'workspace', workspaceId: m.fromRef }, toWorkspaceId: m.toWorkspaceId, body: m.body, threadId, createThread: true, artifactIds });
  }

  // ---- 받기 ----

  private async handle(path: string, body: unknown, host: string): Promise<unknown> {
    if (this.port === null) return { ok: false, error: 'off' };
    try {
      if (path === 'hello') {
        const me = this.me();
        return { v: PROTOCOL, id: me.id, name: this.myName(), pub: me.pub, port: this.port };
      }
      if (path === 'pair') return this.onPair(body, host);
      if (path === 'msg') return await this.onEnvelope(body, host);
      return { ok: false, error: 'unknown' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'error' };
    }
  }

  /** 연결 요청을 받았다. 사용자가 수락하기 전에는 아무것도 믿지 않는다. */
  private onPair(body: unknown, host: string): unknown {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const me = this.me();
    if (b.v !== PROTOCOL || !isId(b.id) || !validPub(b.pub) || b.id === me.id) return { ok: false, error: 'bad request' };
    const port = Number(b.port);
    const address = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 0}`;
    if (!isAddress(address)) return { ok: false, error: 'bad address' };
    this.prune();
    for (const [id, p] of this.pending) if (p.peerId === b.id && p.direction === 'in') this.pending.delete(id);
    if ([...this.pending.values()].filter((p) => p.direction === 'in').length >= MAX_PENDING) return { ok: false, error: 'busy' };
    const pending: Pending = { id: crypto.randomUUID(), peerId: b.id, name: cleanName(b.name, '이름 없음'), pub: b.pub, address, direction: 'in', createdAt: Date.now() };
    this.pending.set(pending.id, pending);
    this.emit('changed');
    return { ok: true };
  }

  private async onEnvelope(body: unknown, host: string): Promise<unknown> {
    const env = (body && typeof body === 'object' ? body : {}) as Partial<Envelope>;
    const me = this.me();
    if (env.v !== PROTOCOL || !isId(env.from) || env.to !== me.id || typeof env.ts !== 'number') return { ok: false, error: 'bad envelope' };
    if (Math.abs(Date.now() - env.ts) > CLOCK_SKEW_MS) return { ok: false, error: 'clock' };
    // 보낸 사람의 열쇠: 연결된 사람이거나, 내가 연결을 요청해 둔 사람 (그 사람의 수락만 받는다).
    const peer = this.peerRow(env.from);
    const waiting = [...this.pending.values()].find((p) => p.direction === 'out' && p.peerId === env.from);
    let payload: Payload | undefined;
    let viaPending = false;
    for (const pub of [peer?.pub, waiting?.pub].filter((x): x is string => typeof x === 'string')) {
      try {
        const key = sharedKey(me.priv, pub, me.pub);
        payload = JSON.parse(open(key, env as Sealed, `${env.from}|${env.to}|${env.ts}`)) as Payload;
        viaPending = pub !== peer?.pub;
        break;
      } catch { /* 다음 열쇠로 */ }
    }
    if (!payload || typeof payload !== 'object' || !isId(payload.id) || typeof payload.type !== 'string') return { ok: false, error: 'cannot open' };
    this.prune();
    if (this.replay.has(payload.id)) return { ok: false, error: 'replay' };
    this.replay.set(payload.id, Date.now());

    if (viaPending || payload.type === 'pair.accept') {
      // 내가 요청한 사람이 수락했다. 그 밖의 것은 받지 않는다.
      if (payload.type !== 'pair.accept' || !waiting) return { ok: false, error: 'not paired' };
      this.upsertPeer({ id: waiting.peerId, name: cleanName(payload.name, waiting.name), pub: waiting.pub, address: waiting.address }, true);
      this.pending.delete(waiting.id);
      this.emit('changed');
      return { ok: true };
    }
    if (!peer) return { ok: false, error: 'not paired' };
    // 주소와 이름을 따라간다.
    const port = Number(payload.port);
    const address = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
    if (Number.isInteger(port) && isAddress(address) && address !== peer.address) this.d.db.prepare('UPDATE peers SET address = ? WHERE id = ?').run(address, peer.id);
    const name = cleanName(payload.name, peer.name);
    if (name !== peer.name) this.d.db.prepare('UPDATE peers SET name = ? WHERE id = ?').run(name, peer.id);
    return this.onPayload(peer, payload);
  }

  private onPayload(peer: PeerRow, p: Payload): unknown {
    const no = (error: string): unknown => ({ ok: false, error });
    switch (p.type) {
      case 'share.invite': {
        // 직접 연결한 사람의 초대만 받는다.
        if (peer.direct !== 1) return no('not direct');
        const share = (p.share && typeof p.share === 'object' ? p.share : {}) as Record<string, unknown>;
        if (!isId(share.id)) return no('bad share');
        if (this.shareRow(share.id)) return { ok: true };
        for (const [id, inv] of this.invites) if (inv.shareId === share.id) this.invites.delete(id);
        if (this.invites.size >= MAX_INVITES) return no('busy');
        const inv: ShareInvite = { id: crypto.randomUUID(), shareId: share.id, name: cleanName(share.name, '프로젝트'), fromPeerId: peer.id, fromName: peer.name, createdAt: Date.now() };
        this.invites.set(inv.id, inv);
        this.emit('changed');
        return { ok: true };
      }
      case 'share.join': {
        const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
        if (!s || !this.isMine(s)) return no('not owner');
        const state = (this.d.db.prepare('SELECT state FROM share_members WHERE share_id = ? AND peer_id = ?').get(s.id, peer.id) as { state: string } | undefined)?.state;
        // 내가 초대한 사람만 들어온다.
        if (!state) return no('not invited');
        this.d.db.prepare("UPDATE share_members SET state = 'member' WHERE share_id = ? AND peer_id = ?").run(s.id, peer.id);
        this.emit('changed');
        void this.broadcastMembers(s).then(() => this.publishSoon());
        return { ok: true };
      }
      case 'share.members': {
        const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
        // 그 프로젝트를 연 사람이 보낸 목록만 받는다.
        if (!s || s.owner_peer !== peer.id) return no('not owner');
        const me = this.me();
        const list = (Array.isArray(p.members) ? p.members : []).slice(0, 50) as Record<string, unknown>[];
        const ids: string[] = [];
        this.d.db.transaction(() => {
          for (const m of list) {
            if (!m || typeof m !== 'object' || !isId(m.id) || m.id === me.id || !validPub(m.pub)) continue;
            // 연 사람 자신의 열쇠와 주소는 이 목록으로 바꾸지 않는다 (이미 직접 연결돼 있다).
            if (m.id !== peer.id) {
              const known = this.peerRow(m.id);
              // 내가 직접 연결한 사람의 열쇠는 목록이 바꾸지 못한다.
              if (!(known && known.direct === 1)) this.upsertPeer({ id: m.id, name: cleanName(m.name, '이름 없음'), pub: m.pub, address: isAddress(m.address) ? m.address : known?.address ?? '' }, false);
            }
            ids.push(m.id);
          }
          if (!ids.includes(peer.id)) ids.push(peer.id);
          this.d.db.prepare('DELETE FROM share_members WHERE share_id = ?').run(s.id);
          for (const id of ids) this.d.db.prepare("INSERT INTO share_members (share_id, peer_id, state) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING").run(s.id, id);
          this.d.db.prepare(`DELETE FROM remote_workspaces WHERE share_id = ? AND peer_id NOT IN (${ids.map(() => '?').join(',')})`).run(s.id, ...ids);
        })();
        this.emit('changed');
        this.publishSoon();
        return { ok: true };
      }
      case 'share.leave': {
        const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
        if (!s || !this.isMine(s)) return no('not owner');
        this.d.db.transaction(() => {
          this.d.db.prepare('DELETE FROM share_members WHERE share_id = ? AND peer_id = ?').run(s.id, peer.id);
          this.d.db.prepare('DELETE FROM remote_workspaces WHERE share_id = ? AND peer_id = ?').run(s.id, peer.id);
        })();
        this.emit('changed');
        void this.broadcastMembers(s);
        return { ok: true };
      }
      case 'share.closed':
      case 'share.removed': {
        const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
        if (s && s.owner_peer === peer.id) this.dropShare(s.id);
        return { ok: true };
      }
      case 'directory': {
        const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
        if (!s || !this.memberIds(s.id).includes(peer.id)) return no('not member');
        const list = (Array.isArray(p.workspaces) ? p.workspaces : []).slice(0, MAX_DIRECTORY) as Record<string, unknown>[];
        this.d.db.transaction(() => {
          // 목록에서 빠진 것은 숨긴다 (지우지 않는다: 이미 주고받은 메시지의 이름이 남아야 한다).
          this.d.db.prepare('UPDATE remote_workspaces SET listed = 0 WHERE share_id = ? AND peer_id = ?').run(s.id, peer.id);
          for (const w of list) {
            if (!w || typeof w !== 'object' || !isId(w.id)) continue;
            this.d.db.prepare('INSERT INTO remote_workspaces (share_id, peer_id, workspace_id, name, listed) VALUES (?, ?, ?, ?, 1) ON CONFLICT(share_id, peer_id, workspace_id) DO UPDATE SET name = excluded.name, listed = 1')
              .run(s.id, peer.id, w.id, cleanName(w.name, '워크스페이스'));
          }
        })();
        this.emit('changed');
        return { ok: true };
      }
      case 'message':
        return this.onMessage(peer, p);
      default: {
        // 다른 기능이 얹은 것 (배정 등). 함께하는 프로젝트의 참여자가 보낸 것만 넘긴다.
        const handler = this.handlers.get(p.type);
        const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
        if (!handler) return no('unknown type');
        if (!s || !this.memberIds(s.id).includes(peer.id)) return no('함께하는 프로젝트의 참여자가 아니다');
        if (this.d.isProjectClosed(s.project_id)) return no('그 프로젝트는 완료됐다');
        return handler({ id: peer.id, name: peer.name }, p, s.project_id) ?? { ok: true };
      }
    }
  }

  /** 다른 사람의 에이전트가 보낸 메시지. 받는 워크스페이스가 그 사람에게 공개돼 있을 때만 받는다. */
  private onMessage(peer: PeerRow, p: Payload): unknown {
    const no = (error: string): unknown => ({ ok: false, error });
    const s = isId(p.shareId) ? this.shareRow(p.shareId) : undefined;
    if (!s || !this.memberIds(s.id).includes(peer.id)) return no('함께하는 프로젝트의 참여자가 아니다');
    if (this.d.isProjectClosed(s.project_id)) return no('그 프로젝트는 완료됐다');
    const from = (p.from && typeof p.from === 'object' ? p.from : {}) as Record<string, unknown>;
    const to = this.d.workspaces.get(String(p.to ?? ''));
    // 공개하지 않은 워크스페이스는 있는지 없는지도 알려 주지 않는다.
    if (!isId(from.id) || !to || to.projectId !== s.project_id || !this.visibleTo(to.id, peer.id)) return no('그 워크스페이스에는 보낼 수 없다 (없거나 공개돼 있지 않다)');
    const body = typeof p.body === 'string' ? p.body.trim() : '';
    if (!body || body.length > MAX_BODY) return no('메시지가 비었거나 너무 길다');
    const thread = isId(p.thread) ? p.thread : crypto.randomUUID();
    const now = Date.now();
    const recent = (this.rate.get(peer.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RATE_PER_MIN) return no('너무 자주 보낸다. 잠시 뒤에 보내라');
    this.rate.set(peer.id, [...recent, now]);
    const artifacts: WireArtifact[] = (Array.isArray(p.artifacts) ? p.artifacts : []).slice(0, MAX_ARTIFACTS)
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map((a) => ({ kind: oneLine(a.kind, 20), title: oneLine(a.title, 120) || '자료', body: String(a.body ?? '').slice(0, MAX_ARTIFACT_BODY) }));
    // 보낸 워크스페이스의 이름을 알아 둔다 (목록에 없던 것이어도 누가 보냈는지 보여 줄 수 있게. 목록에는 올리지 않는다).
    this.d.db.prepare('INSERT INTO remote_workspaces (share_id, peer_id, workspace_id, name, listed) VALUES (?, ?, ?, ?, 0) ON CONFLICT(share_id, peer_id, workspace_id) DO UPDATE SET name = excluded.name')
      .run(s.id, peer.id, from.id, cleanName(from.name, '워크스페이스'));
    if (peer.mode === 'direct') {
      this.deliver({ projectId: s.project_id, fromRef: remoteRef(peer.id, from.id), toWorkspaceId: to.id, body, thread, artifacts });
      return { ok: true, delivery: 'delivered' };
    }
    // 사용자가 보고 넘겨줄 때까지 붙잡아 둔다. 너무 쌓이면 받지 않는다.
    const waitingCount = (this.d.db.prepare('SELECT count(*) AS n FROM peer_inbox WHERE from_peer = ?').get(peer.id) as { n: number }).n;
    if (waitingCount >= 50) return no('받는 쪽의 사용자가 아직 확인하지 않은 메시지가 많다. 기다려라');
    this.d.db.prepare('INSERT INTO peer_inbox (id, share_id, from_peer, from_workspace, to_workspace_id, body, thread, artifacts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), s.id, peer.id, from.id, to.id, body, thread, JSON.stringify(artifacts), now);
    this.emit('changed');
    return { ok: true, delivery: 'held' };
  }
}
