import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Proposal, ProposalItem, Workspace } from '@shared/types';
import type { Git } from './git';
import type { MessageService } from './messages';
import type { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import type { WorkspaceService } from './workspaceService';

interface Row { id: string; project_id: string; status: string; items: string; note: string; created_at: number }

const MAX_ITEMS = 20;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

function toProposal(r: Row): Proposal {
  let items: ProposalItem[] = [];
  try { const v = JSON.parse(r.items) as unknown; if (Array.isArray(v)) items = v as ProposalItem[]; } catch { /* 빈 제안 */ }
  return { id: r.id, projectId: r.project_id, status: r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending', items, note: r.note, createdAt: r.created_at };
}

export const COORDINATOR_NAME = '조율';

/**
 * 프로젝트 조율. 조율 에이전트는 프로젝트마다 하나 있고, 두레가 관리하는 폴더에서 돈다 (어느 저장소에도 직접 쓰지 않는다).
 * 워크스페이스는 조율 에이전트가 제안하고 사용자가 승인해야 만들어진다.
 * 이벤트: 'changed' (projectId) — 제안이 생기거나 결정됨
 */
export class CoordinatorService extends EventEmitter {
  constructor(private readonly d: {
    db: Database.Database;
    projects: ProjectStore;
    repos: RepoStore;
    workspaces: WorkspaceStore;
    messages: MessageService;
    git: Git;
    service: WorkspaceService;
    /** 조율 에이전트의 폴더를 두는 곳 (두레 데이터 폴더 아래) */
    dir: string;
  }) {
    super();
  }

  /** 프로젝트의 조율 에이전트. 없으면 만든다. */
  ensure(projectId: string): Workspace {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    const found = this.d.workspaces.coordinator(projectId);
    if (found) return found;
    const dir = join(this.d.dir, projectId);
    mkdirSync(dir, { recursive: true });
    const repo = this.d.repos.addInternal(projectId, dir);
    return this.d.workspaces.insert({
      id: crypto.randomUUID(), projectId, repoId: repo.id, role: 'coordinator', name: COORDINATOR_NAME, nameLocked: true,
      branch: '', baseBranch: '', worktreePath: dir, agentKind: 'claude', permissionMode: 'ask', engine: 'chat',
      token: randomBytes(32).toString('hex'),
    });
  }

  /** 승인을 기다리는 제안. 프로젝트마다 하나뿐이다. */
  pending(projectId: string): Proposal | null {
    const r = this.d.db.prepare("SELECT * FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(projectId) as Row | undefined;
    return r ? toProposal(r) : null;
  }

  /** 제안 한 건을 화면에 올릴 모양으로 다듬는다. 저장소는 이름으로 받는다 (에이전트는 id 를 모른다). */
  private async clean(projectId: string, raw: unknown[]): Promise<{ items: ProposalItem[]; problems: string[] }> {
    const repos = this.d.repos.list(projectId);
    const items: ProposalItem[] = [];
    const problems: string[] = [];
    for (const [i, x] of raw.slice(0, MAX_ITEMS).entries()) {
      const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
      const name = oneLine(o.name, 60);
      const repoKey = oneLine(o.repo ?? o.repoId, 300);
      const repo = repos.find((r) => r.id === repoKey) ?? repos.find((r) => r.name === repoKey) ?? repos.find((r) => r.path === repoKey);
      if (!name) { problems.push(`${i + 1}번째: 이름이 없다`); continue; }
      if (!repo) { problems.push(`"${name}": 등록된 저장소가 아니다 (${repoKey || '저장소 없음'}). 등록된 저장소: ${repos.map((r) => r.name).join(', ') || '없음'}`); continue; }
      const branches = await this.d.git.listBranches(repo.path).catch(() => [] as string[]);
      const wanted = oneLine(o.base_branch ?? o.baseBranch, 200);
      let baseBranch = wanted;
      if (!wanted) baseBranch = await this.d.git.currentBranch(repo.path).catch(() => branches[0] ?? '');
      else if (!branches.includes(wanted)) { problems.push(`"${name}": 저장소 ${repo.name} 에 브랜치 ${wanted} 가 없다. 있는 브랜치: ${branches.slice(0, 20).join(', ')}`); continue; }
      if (!baseBranch) { problems.push(`"${name}": 저장소 ${repo.name} 의 기준 브랜치를 정할 수 없다`); continue; }
      items.push({ name, repoId: repo.id, baseBranch, role: oneLine(o.role, 500) });
    }
    return { items, problems };
  }

  /**
   * 조율 에이전트가 워크스페이스를 제안한다. 앞의 미결 제안은 이 제안으로 바뀐다.
   * 문제가 있는 항목이 하나라도 있으면 아무것도 올리지 않고 이유를 던진다 (에이전트가 고쳐서 다시 낸다).
   */
  async propose(projectId: string, raw: unknown, note: unknown): Promise<Proposal> {
    if (!this.d.projects.get(projectId)) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('제안할 워크스페이스가 없다.');
    if (raw.length > MAX_ITEMS) throw new Error(`한 번에 ${MAX_ITEMS}개까지 제안할 수 있다.`);
    const { items, problems } = await this.clean(projectId, raw);
    if (problems.length) throw new Error(`제안을 올리지 않았다. 고쳐서 다시 내라: ${problems.join(' / ')}`);
    const id = crypto.randomUUID();
    this.d.db.transaction(() => {
      this.d.db.prepare("UPDATE proposals SET status = 'rejected' WHERE project_id = ? AND status = 'pending'").run(projectId);
      this.d.db.prepare('INSERT INTO proposals (id, project_id, status, items, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, projectId, 'pending', JSON.stringify(items), oneLine(note, 1000), Date.now());
    })();
    this.emit('changed', projectId);
    return this.pending(projectId)!;
  }

  /** 조율 에이전트에게 두레의 알림으로 알린다 (꺼져 있으면 이 알림으로 뜬다). */
  private tell(projectId: string, text: string): void {
    const coordinator = this.d.workspaces.coordinator(projectId);
    if (!coordinator) return;
    try {
      this.d.messages.send({ projectId, from: { kind: 'system' }, toWorkspaceId: coordinator.id, body: text, title: '워크스페이스 제안' });
    } catch { /* 알림 실패가 승인 결과를 바꾸면 안 된다 */ }
  }

  /**
   * 사용자가 제안을 승인한다. items 는 사용자가 화면에서 고친 최종 목록이다.
   * 전부 만들 수 있는지 먼저 확인하고, 하나라도 안 되면 아무것도 만들지 않는다.
   */
  async approve(proposalId: string, edited: unknown): Promise<Workspace[]> {
    const r = this.d.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as Row | undefined;
    if (!r || r.status !== 'pending') throw new Error('승인을 기다리는 제안이 아닙니다.');
    if (!Array.isArray(edited) || edited.length === 0) throw new Error('만들 워크스페이스가 없습니다. 거절하려면 "거절" 을 누르세요.');
    const { items, problems } = await this.clean(r.project_id, edited);
    if (problems.length) throw new Error(problems.join(' / '));
    const names = new Set<string>();
    for (const it of items) {
      if (names.has(it.name)) throw new Error(`이름이 겹칩니다: ${it.name}`);
      names.add(it.name);
    }
    const taken = this.d.workspaces.listAll(r.project_id).map((w) => w.name);
    const clash = items.find((it) => taken.includes(it.name));
    if (clash) throw new Error(`이미 있는 워크스페이스 이름입니다: ${clash.name}`);
    const created: Workspace[] = [];
    try {
      for (const it of items) {
        const ws = await this.d.service.create({ projectId: r.project_id, repoId: it.repoId, name: it.name, baseBranch: it.baseBranch, agentKind: 'claude' });
        if (it.role) this.d.workspaces.update(ws.id, { summary: it.role });
        created.push(this.d.workspaces.get(ws.id) ?? ws);
      }
    } catch (e) {
      // 도중에 실패하면 만든 것을 되돌린다: 반쯤 만들어진 채로 두지 않는다.
      for (const ws of created) await this.d.service.remove(ws.id, { deleteWorktree: true }).catch(() => undefined);
      throw e;
    }
    this.d.db.prepare("UPDATE proposals SET status = 'approved', items = ? WHERE id = ?").run(JSON.stringify(items), proposalId);
    this.emit('changed', r.project_id);
    this.tell(r.project_id, [
      '사용자가 워크스페이스 제안을 승인했다. 만들어진 워크스페이스:',
      ...created.map((w) => `- "${w.name}" (저장소 ${this.d.repos.get(w.repoId)?.name ?? ''}, 브랜치 ${w.branch})${w.summary ? `: ${w.summary}` : ''}`),
      '사용자가 제안을 고쳤을 수 있다. 위 목록이 최종이다. 이어서 할 일을 진행하라.',
    ].join('\n'));
    return created;
  }

  /** 사용자가 제안을 거절한다. 이유가 있으면 조율 에이전트에게 전한다. */
  reject(proposalId: string, reason?: string): void {
    const r = this.d.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as Row | undefined;
    if (!r || r.status !== 'pending') throw new Error('승인을 기다리는 제안이 아닙니다.');
    this.d.db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(proposalId);
    this.emit('changed', r.project_id);
    const why = oneLine(reason, 500);
    this.tell(r.project_id, `사용자가 워크스페이스 제안을 거절했다. 워크스페이스는 만들어지지 않았다.${why ? ` 이유: ${why}` : ''} 사용자의 뜻을 확인하고 필요하면 다시 제안하라.`);
  }
}
