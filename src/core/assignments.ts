import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { remoteLabel } from '@shared/remote';
import type { AssignChoice, AssignItem, AssignmentIn, AssignmentOut, AssignProgress, PlanTodo, Workspace } from '@shared/types';
import type { CoordinatorService } from './coordinator';
import type { MessageService } from './messages';
import type { PeerService } from './peers/peerService';
import type { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import type { TodoService } from './todos';
import { COORDINATOR_NAME, type WorkspaceService } from './workspaceService';

interface OutRow { id: string; project_id: string; peer_id: string; payload: string; state: string; progress: string; note: string; created_at: number; updated_at: number }
interface InRow { id: string; project_id: string; from_peer: string; payload: string; state: string; workspaces: string; created_at: number }
interface Body { summary: string; items: AssignItem[] }

const MAX_ITEMS = 20;
const MAX_TODOS = 40;
const MAX_SUMMARY = 20_000;
const MAX_PENDING = 20;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
// eslint-disable-next-line no-control-regex
const text = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, max);
const isId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const parse = <T>(raw: string, fallback: T): T => { try { return JSON.parse(raw) as T; } catch { return fallback; } };

/** 남이 보낸 배정의 내용을 다듬는다. 믿지 않는다: 모양과 크기를 다시 본다. */
function cleanBody(raw: unknown): Body | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.items) ? o.items.slice(0, MAX_ITEMS) : [];
  const items: AssignItem[] = [];
  for (const x of list) {
    const it = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const name = oneLine(it.name, 40).replace(/[@"]/g, '');
    if (!name || name === COORDINATOR_NAME) continue;
    const todos: PlanTodo[] = (Array.isArray(it.todos) ? it.todos.slice(0, MAX_TODOS) : [])
      .map((t) => (t && typeof t === 'object' ? t : {}) as Record<string, unknown>)
      .map((t) => ({ title: oneLine(t.title, 200), detail: text(t.detail, 1000), assignee: t.assignee === 'user' ? 'user' as const : 'agent' as const }))
      .filter((t) => t.title);
    items.push({ name, role: oneLine(it.role, 500), todos });
  }
  return items.length ? { summary: text(o.summary, MAX_SUMMARY), items } : null;
}

/**
 * 배정: 계획안의 일을 함께하는 사람에게 나눠 준다.
 * - 나눠 주는 쪽: 계획안을 승인할 때 남의 몫을 그 사람에게 보낸다 (기획서 정리, 워크스페이스, TODO). 그 사람의 진행을 읽기 전용으로 본다.
 * - 받는 쪽: 화면에 배정이 뜬다. 사용자가 수락해야 워크스페이스와 TODO 가 만들어진다. 어느 저장소에 만들지는 받는 사람이 고른다.
 *   남이 내 PC 에 폴더와 브랜치를 만들 수 없다: 받은 것은 수락 전에는 기록일 뿐이다.
 * 이벤트: 'changed'
 */
export class AssignmentService extends EventEmitter {
  private progressTimer: NodeJS.Timeout | undefined;
  private readonly accepting = new Set<string>();

  constructor(private readonly d: {
    db: Database.Database; peers: PeerService; projects: ProjectStore; repos: RepoStore; workspaces: WorkspaceStore;
    todos: TodoService; messages: MessageService; service: WorkspaceService; coordinator(): CoordinatorService;
  }) {
    super();
    d.peers.on2('assign', (peer, p, projectId) => this.onAssign(peer, p, projectId));
    d.peers.on2('assign.cancel', (peer, p) => this.onCancel(peer, p));
    d.peers.on2('assign.accepted', (peer, p) => this.onAnswer(peer, p, 'accepted'));
    d.peers.on2('assign.declined', (peer, p) => this.onAnswer(peer, p, 'declined'));
    d.peers.on2('assign.progress', (peer, p) => this.onProgress(peer, p));
    // 나눠 받은 일의 진행이 바뀌면 나눠 준 사람에게 알린다.
    d.todos.on('changed', () => this.progressSoon());
    d.service.on('changed', () => this.progressSoon());
  }

  dispose(): void { clearTimeout(this.progressTimer); }

  // ---- 나눠 주는 쪽 ----

  /** 함께하는 사람에게 배정을 보낸다. 닿지 않으면 던지고 아무것도 남기지 않는다. */
  async send(projectId: string, peerId: string, a: Body): Promise<string> {
    const body = cleanBody(a);
    if (!body) throw new Error('나눠 줄 일이 없습니다.');
    const id = crypto.randomUUID();
    await this.d.peers.sendMember(projectId, peerId, { type: 'assign', assignment: { aid: id, ...body } });
    const now = Date.now();
    this.d.db.prepare('INSERT INTO assignments_out (id, project_id, peer_id, payload, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, peerId, JSON.stringify(body), 'sent', now, now);
    // 그 사람의 에이전트가 보고하고 물어볼 곳: 내 조율 에이전트를 그 사람에게 보이게 한다.
    const coordinator = this.d.workspaces.coordinator(projectId);
    if (coordinator) { try { this.d.peers.allow(coordinator.id, peerId); } catch { /* 공개하지 못해도 배정은 간다 */ } }
    this.emit('changed');
    return id;
  }

  /** 보낸 배정을 거둔다 (승인 도중 실패했을 때). 상대가 아직 수락하지 않았으면 상대 화면에서도 사라진다. */
  async cancel(id: string): Promise<void> {
    const r = this.d.db.prepare('SELECT * FROM assignments_out WHERE id = ?').get(id) as OutRow | undefined;
    if (!r) return;
    this.d.db.prepare('DELETE FROM assignments_out WHERE id = ?').run(id);
    await this.d.peers.sendMember(r.project_id, r.peer_id, { type: 'assign.cancel', aid: id }).catch(() => undefined);
    this.emit('changed');
  }

  private peerName(projectId: string, peerId: string): string {
    return this.d.peers.people(projectId).find((p) => p.peerId === peerId)?.name ?? this.d.peers.peers().find((p) => p.id === peerId)?.name ?? '알 수 없는 사람';
  }

  /** 내가 나눠 준 일과 그 진행. */
  outgoing(projectId: string): AssignmentOut[] {
    return (this.d.db.prepare('SELECT * FROM assignments_out WHERE project_id = ? ORDER BY created_at').all(projectId) as OutRow[]).map((r) => ({
      id: r.id, projectId: r.project_id, peerId: r.peer_id, peerName: this.peerName(r.project_id, r.peer_id),
      state: r.state === 'accepted' ? 'accepted' : r.state === 'declined' ? 'declined' : 'sent',
      items: parse<Body>(r.payload, { summary: '', items: [] }).items, progress: parse<AssignProgress[]>(r.progress, []), note: r.note, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  private tellCoordinator(projectId: string, body: string): void {
    const c = this.d.workspaces.coordinator(projectId);
    if (!c) return;
    try { this.d.messages.send({ projectId, from: { kind: 'system' }, toWorkspaceId: c.id, body, title: '배정' }); } catch { /* 알림 실패가 결과를 바꾸면 안 된다 */ }
  }

  private onAnswer(peer: { id: string; name: string }, p: Record<string, unknown>, state: 'accepted' | 'declined'): unknown {
    const r = isId(p.aid) ? this.d.db.prepare('SELECT * FROM assignments_out WHERE id = ?').get(p.aid) as OutRow | undefined : undefined;
    // 내가 그 사람에게 보낸 배정에 대한 답만 받는다.
    if (!r || r.peer_id !== peer.id || r.state !== 'sent') return { ok: false, error: '그런 배정이 없다' };
    const note = state === 'declined' ? oneLine(p.reason, 300) : '';
    this.d.db.prepare('UPDATE assignments_out SET state = ?, note = ?, updated_at = ? WHERE id = ?').run(state, note, Date.now(), r.id);
    const names = (Array.isArray(p.workspaces) ? p.workspaces : []).slice(0, MAX_ITEMS).map((w) => oneLine((w as Record<string, unknown>)?.name, 40).replace(/[@"]/g, '')).filter(Boolean);
    this.tellCoordinator(r.project_id, state === 'accepted'
      ? [`${peer.name} 이(가) 나눠 준 일을 수락했다. 그 사람의 두레에 워크스페이스와 TODO 가 만들어졌고, 두레가 그쪽 에이전트에게 시작하라고 알렸다 (네가 따로 시작을 알릴 필요는 없다).`,
        ...names.map((n) => `- "${remoteLabel(n, peer.name)}"`),
        '그쪽 에이전트가 보고하거나 물으면 message_send 로 답하라 (받는 쪽은 위의 "이름@사람"). 다른 PC 다: 파일 경로는 통하지 않으니 내용을 글로 보내라. 그 사람의 진행은 todo_list 의 assigned 에 보인다.'].join('\n')
      : `${peer.name} 이(가) 나눠 준 일을 거절했다.${note ? ` 이유: ${note}` : ''} 사용자에게 알리고, 어떻게 할지 물어라.`);
    this.emit('changed');
    return { ok: true };
  }

  private onProgress(peer: { id: string; name: string }, p: Record<string, unknown>): unknown {
    const r = isId(p.aid) ? this.d.db.prepare('SELECT * FROM assignments_out WHERE id = ?').get(p.aid) as OutRow | undefined : undefined;
    if (!r || r.peer_id !== peer.id || r.state !== 'accepted') return { ok: false, error: '그런 배정이 없다' };
    const progress: AssignProgress[] = (Array.isArray(p.workspaces) ? p.workspaces : []).slice(0, MAX_ITEMS)
      .map((w) => (w && typeof w === 'object' ? w : {}) as Record<string, unknown>)
      .filter((w) => isId(w.workspaceId))
      .map((w) => ({
        workspaceId: String(w.workspaceId), name: oneLine(w.name, 40).replace(/[@"]/g, '') || '워크스페이스', status: oneLine(w.status, 20), summary: oneLine(w.summary, 80),
        todos: (Array.isArray(w.todos) ? w.todos : []).slice(0, 100).map((t) => (t && typeof t === 'object' ? t : {}) as Record<string, unknown>)
          .map((t) => ({ title: oneLine(t.title, 200), status: oneLine(t.status, 20), assignee: t.assignee === 'user' ? 'user' : 'agent' })).filter((t) => t.title),
      }));
    this.d.db.prepare('UPDATE assignments_out SET progress = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(progress), Date.now(), r.id);
    this.emit('changed');
    return { ok: true };
  }

  // ---- 받는 쪽 ----

  private onAssign(peer: { id: string; name: string }, p: Record<string, unknown>, projectId: string): unknown {
    const a = (p.assignment && typeof p.assignment === 'object' ? p.assignment : {}) as Record<string, unknown>;
    const body = cleanBody(a);
    if (!isId(a.aid) || !body) return { ok: false, error: '배정의 내용이 올바르지 않다' };
    if (this.d.db.prepare('SELECT 1 FROM assignments_in WHERE id = ?').get(a.aid)) return { ok: true };
    const waiting = (this.d.db.prepare("SELECT count(*) AS n FROM assignments_in WHERE from_peer = ? AND state = 'pending'").get(peer.id) as { n: number }).n;
    if (waiting >= MAX_PENDING) return { ok: false, error: '받는 쪽에 아직 확인하지 않은 배정이 많다' };
    this.d.db.prepare('INSERT INTO assignments_in (id, project_id, from_peer, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(a.aid, projectId, peer.id, JSON.stringify(body), 'pending', Date.now());
    this.emit('changed');
    return { ok: true };
  }

  private onCancel(peer: { id: string; name: string }, p: Record<string, unknown>): unknown {
    // 아직 수락하지 않은 것만 거둔다. 이미 만든 워크스페이스는 건드리지 않는다.
    if (isId(p.aid)) this.d.db.prepare("DELETE FROM assignments_in WHERE id = ? AND from_peer = ? AND state = 'pending'").run(p.aid, peer.id);
    this.emit('changed');
    return { ok: true };
  }

  private toIn(r: InRow): AssignmentIn {
    const b = parse<Body>(r.payload, { summary: '', items: [] });
    return { id: r.id, projectId: r.project_id, fromPeerId: r.from_peer, fromName: this.peerName(r.project_id, r.from_peer), summary: b.summary, items: b.items, state: r.state === 'accepted' ? 'accepted' : r.state === 'declined' ? 'declined' : 'pending', createdAt: r.created_at };
  }

  /** 받은 배정. projectId 를 주지 않으면 전부. */
  incoming(projectId?: string): AssignmentIn[] {
    const rows = (projectId
      ? this.d.db.prepare('SELECT * FROM assignments_in WHERE project_id = ? ORDER BY created_at').all(projectId)
      : this.d.db.prepare('SELECT * FROM assignments_in ORDER BY created_at').all()) as InRow[];
    return rows.map((r) => this.toIn(r));
  }

  /**
   * 받은 배정을 수락한다: 내 프로젝트에 워크스페이스와 TODO 를 만들고, 기획서 정리를 자료로 둔다.
   * choices: 워크스페이스마다 어느 저장소에 만들지 (순서는 배정의 items 와 같다).
   * share: 만든 워크스페이스를 나눠 준 사람에게 공개한다 (그 사람의 조율 에이전트와 메시지를 주고받고, 진행이 보인다).
   */
  async accept(id: string, choices: AssignChoice[], o: { share?: boolean } = {}): Promise<Workspace[]> {
    if (this.accepting.has(id)) throw new Error('이미 처리하는 중입니다.');
    this.accepting.add(id);
    try {
      const r = this.d.db.prepare('SELECT * FROM assignments_in WHERE id = ?').get(id) as InRow | undefined;
      if (!r || r.state !== 'pending') throw new Error('수락을 기다리는 배정이 아닙니다.');
      if (this.d.service.isProjectClosed(r.project_id)) throw new Error('완료된 프로젝트입니다.');
      const a = this.toIn(r);
      if (!Array.isArray(choices) || choices.length !== a.items.length) throw new Error('워크스페이스마다 저장소를 골라야 합니다.');
      const repos = this.d.repos.list(r.project_id);
      // 전부 만들 수 있는지 먼저 본다.
      const plan = a.items.map((it, i) => {
        const c = choices[i] ?? { repoId: '' };
        const name = oneLine(c.name ?? it.name, 40).replace(/[@"]/g, '') || it.name;
        if (name === COORDINATOR_NAME) throw new Error(`"${COORDINATOR_NAME}" 은 조율 에이전트의 이름이라 쓸 수 없습니다.`);
        if (c.repoId && !repos.some((x) => x.id === c.repoId)) throw new Error(`"${name}": 이 프로젝트에 등록된 저장소가 아닙니다.`);
        if (!c.repoId && !c.newRepo?.trim()) throw new Error(`"${name}": 저장소를 고르거나 새 저장소의 이름을 적으세요.`);
        return { item: it, name, repoId: c.repoId, newRepo: c.newRepo?.trim() ?? '' };
      });
      const created: Workspace[] = [];
      const todoIds: string[] = [];
      const newRepos = new Map<string, string>();
      let artifactId: string | undefined;
      try {
        for (const p of plan) {
          let repoId = p.repoId;
          if (!repoId) {
            // 같은 이름의 새 저장소를 여러 워크스페이스가 쓰면 한 번만 만든다.
            repoId = newRepos.get(p.newRepo) ?? (await this.d.coordinator().createEmptyRepo(r.project_id, p.newRepo, `${a.fromName} 이(가) 나눠 준 일`)).id;
            newRepos.set(p.newRepo, repoId);
          }
          const repo = this.d.repos.get(repoId)!;
          const baseBranch = await this.d.coordinator().currentBranch(repo.path);
          // 권한은 "승인 필요" 로 만든다: 남이 나눠 준 일이 승인 생략으로 돌지 않게 한다.
          const ws = await this.d.service.create({ projectId: r.project_id, repoId, name: p.name, baseBranch, agentKind: 'claude', permissionMode: 'ask' });
          if (p.item.role) this.d.workspaces.update(ws.id, { summary: p.item.role.slice(0, 80) });
          created.push(this.d.workspaces.get(ws.id) ?? ws);
          for (const t of p.item.todos) todoIds.push(this.d.todos.add({ projectId: r.project_id, workspaceId: ws.id, ...t }, 'agent').id);
        }
        if (a.summary) artifactId = this.d.messages.publish({ projectId: r.project_id, workspaceId: created[0]!.id, kind: 'note', title: `기획서 정리 (${a.fromName} 이(가) 보냄)`, body: a.summary }).id;
      } catch (e) {
        for (const t of todoIds) { try { this.d.todos.remove(t, { actor: 'user' }); } catch { /* 이미 없음 */ } }
        const left: string[] = [];
        for (const ws of created) await this.d.service.discard(ws.id).catch(() => { left.push(ws.name); });
        const why = e instanceof Error ? e.message : String(e);
        throw new Error(left.length ? `${why} (만들던 것을 되돌리지 못했습니다. 남은 워크스페이스: ${left.join(', ')})` : why);
      }
      this.d.db.prepare("UPDATE assignments_in SET state = 'accepted', workspaces = ? WHERE id = ?").run(JSON.stringify(created.map((w) => w.id)), id);
      if (o.share !== false) for (const ws of created) { try { this.d.peers.allow(ws.id, r.from_peer); } catch { /* 공개하지 못해도 일은 받았다 */ } }
      await this.d.peers.sendMember(r.project_id, r.from_peer, { type: 'assign.accepted', aid: id, workspaces: created.map((w) => ({ id: w.id, name: w.name })) }).catch(() => undefined);
      // 만든 워크스페이스의 에이전트에게 무엇을 받았는지 알린다 (꺼져 있으면 이 알림으로 뜬다).
      const coordinatorLabel = remoteLabel(COORDINATOR_NAME, a.fromName);
      for (const ws of created) {
        try {
          this.d.messages.send({
            projectId: r.project_id, from: { kind: 'system' }, toWorkspaceId: ws.id, title: '배정', artifactIds: artifactId ? [artifactId] : [],
            body: [
              `이 워크스페이스는 다른 사람(${a.fromName})이 나눠 준 일을 맡는다. 네 사용자가 내용을 보고 수락했다.`,
              ws.summary ? `맡은 일: ${ws.summary}` : '',
              artifactId ? '기획서 정리가 자료로 붙어 있다. 먼저 읽어라.' : '',
              '할 일은 todo_list 에 있다. 순서대로 진행하고 상태를 갱신하라 (나눠 준 사람에게 진행이 보인다).',
              o.share !== false ? `질문이나 보고는 "${coordinatorLabel}" 에게 message_send 로 보내라 (project_overview 의 otherPeople 에 보이면 보낼 수 있다). 다른 PC 다: 파일 경로는 통하지 않으니 내용을 글로 보내라.` : '',
            ].filter(Boolean).join('\n'),
          });
        } catch { /* 알림 실패가 수락을 되돌리면 안 된다 */ }
      }
      this.emit('changed');
      this.progressSoon();
      return created;
    } finally {
      this.accepting.delete(id);
    }
  }

  /** 받은 배정을 거절한다. 이유가 나눠 준 사람에게 간다. */
  async decline(id: string, reason?: string): Promise<void> {
    const r = this.d.db.prepare('SELECT * FROM assignments_in WHERE id = ?').get(id) as InRow | undefined;
    if (!r || r.state !== 'pending') throw new Error('수락을 기다리는 배정이 아닙니다.');
    this.d.db.prepare("UPDATE assignments_in SET state = 'declined' WHERE id = ?").run(id);
    await this.d.peers.sendMember(r.project_id, r.from_peer, { type: 'assign.declined', aid: id, reason: oneLine(reason, 300) }).catch(() => undefined);
    this.emit('changed');
  }

  /** 나눠 받은 일의 진행을 나눠 준 사람에게 보낸다. 그 사람에게 공개된 워크스페이스의 것만 간다. */
  private progressSoon(): void {
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => { void this.progressNow(); }, 800);
    this.progressTimer.unref?.();
  }

  async progressNow(): Promise<void> {
    const rows = this.d.db.prepare("SELECT * FROM assignments_in WHERE state = 'accepted'").all() as InRow[];
    for (const r of rows) {
      if (this.d.service.isProjectClosed(r.project_id)) continue;
      const all = this.d.todos.listProject(r.project_id);
      const workspaces: AssignProgress[] = parse<string[]>(r.workspaces, [])
        .map((id) => this.d.workspaces.get(id)).filter((w): w is Workspace => w !== undefined)
        // 받는 사람이 공개를 끄면 진행도 더 보내지 않는다.
        .filter((w) => this.d.peers.visibleTo(w.id, r.from_peer))
        .map((w) => ({ workspaceId: w.id, name: w.name, status: w.status, summary: w.summary, todos: all.filter((t) => t.workspaceId === w.id).map((t) => ({ title: t.title, status: t.status, assignee: t.assignee })) }));
      await this.d.peers.sendMember(r.project_id, r.from_peer, { type: 'assign.progress', aid: r.id, workspaces }).catch(() => undefined);
    }
  }
}
