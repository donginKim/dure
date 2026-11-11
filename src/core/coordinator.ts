import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { isNewRepoId, newRepoId, newRepoName, REPO_NAME } from '@shared/plan';
import type { PlanDecision, PlanRepo, PlanResult, PlanTodo, Proposal, ProposalItem, Repo, SpecFile, Workspace } from '@shared/types';
import type { Git } from './git';
import type { MessageService } from './messages';
import { slugify } from './slug';
import type { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import type { TodoService } from './todos';
import { COORDINATOR_NAME, type WorkspaceService } from './workspaceService';

interface Row { id: string; project_id: string; status: string; items: string; note: string; created_at: number }

const MAX_ITEMS = 20;
const MAX_NEW_REPOS = 5;
const MAX_TODOS = 40;
const MAX_SUMMARY = 20_000;
/** 기획서 파일을 글로 넘길 때의 상한. 넘으면 뒤를 자르고 알린다 */
export const MAX_SPEC_BYTES = 300_000;
// eslint-disable-next-line no-control-regex
const oneLine = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
// eslint-disable-next-line no-control-regex
const text = (s: unknown, max: number): string => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, max);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toProposal(r: Row): Proposal {
  let plan: { summary?: unknown; newRepos?: unknown; items?: unknown; projectTodos?: unknown } = {};
  try { const v = JSON.parse(r.items) as unknown; plan = Array.isArray(v) ? { items: v } : isObj(v) ? v : {}; } catch { /* 빈 계획 */ }
  return {
    id: r.id, projectId: r.project_id, status: r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending',
    summary: typeof plan.summary === 'string' ? plan.summary : '',
    newRepos: Array.isArray(plan.newRepos) ? plan.newRepos as PlanRepo[] : [],
    items: Array.isArray(plan.items) ? (plan.items as ProposalItem[]).map((i) => ({ ...i, todos: Array.isArray(i.todos) ? i.todos : [], existing: i.existing === true })) : [],
    projectTodos: Array.isArray(plan.projectTodos) ? plan.projectTodos as PlanTodo[] : [],
    note: r.note, createdAt: r.created_at,
  };
}

export { COORDINATOR_NAME };

/**
 * 프로젝트 조율. 조율 에이전트는 프로젝트마다 하나 있고, 두레가 관리하는 폴더에서 돈다 (어느 저장소에도 직접 쓰지 않는다).
 * 조율 에이전트는 기획서를 분석해 계획안(정리, 워크스페이스, TODO)을 올릴 뿐이다. 만드는 것은 사용자가 승인한 뒤에 두레가 한다.
 * 이벤트: 'changed' (projectId) — 계획안이 생기거나 결정됨
 */
export class CoordinatorService extends EventEmitter {
  /** 승인을 처리하는 중인 계획안. 버튼을 두 번 눌러도 두 벌 만들지 않는다 */
  private readonly deciding = new Set<string>();

  constructor(private readonly d: {
    db: Database.Database;
    projects: ProjectStore;
    repos: RepoStore;
    workspaces: WorkspaceStore;
    todos: TodoService;
    messages: MessageService;
    git: Git;
    service: WorkspaceService;
    /** 조율 에이전트의 폴더를 두는 곳 (두레 데이터 폴더 아래) */
    dir: string;
    /** 새 저장소를 만드는 상위 폴더. 그 아래 프로젝트 이름의 폴더에 만든다 */
    repoRoot: string;
  }) {
    super();
  }

  /** 프로젝트의 조율 에이전트. 없으면 만든다. */
  ensure(projectId: string): Workspace {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    const found = this.d.workspaces.coordinator(projectId);
    if (found) return found;
    // 완료된 프로젝트에서는 새로 만들지 않는다 (탭을 열기만 해도 생기지 않게).
    if (this.d.service.isProjectClosed(projectId)) throw new Error('완료된 프로젝트입니다. 조율 에이전트가 없습니다.');
    const dir = join(this.d.dir, projectId);
    mkdirSync(dir, { recursive: true });
    const repo = this.d.repos.addInternal(projectId, dir);
    const made = this.d.workspaces.insert({
      id: crypto.randomUUID(), projectId, repoId: repo.id, role: 'coordinator', name: COORDINATOR_NAME, nameLocked: true,
      branch: '', baseBranch: '', worktreePath: dir, agentKind: 'claude', permissionMode: 'ask', engine: 'chat',
      token: randomBytes(32).toString('hex'),
    });
    this.emit('changed', projectId);
    return made;
  }

  /** 승인을 기다리는 계획안. 프로젝트마다 하나뿐이다. */
  pending(projectId: string): Proposal | null {
    const r = this.d.db.prepare("SELECT * FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(projectId) as Row | undefined;
    return r ? toProposal(r) : null;
  }

  /** 이 프로젝트의 새 저장소가 만들어질 폴더. */
  newRepoDir(projectId: string): string {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    return join(this.d.repoRoot, slugify(project.name));
  }

  /** 계획안의 새 저장소를 확인한다: 폴더 이름이 될 수 있고, 등록된 저장소와 겹치지 않고, 그 자리에 아무것도 없어야 한다. */
  private newRepos(projectId: string, raw: unknown, problems: string[]): PlanRepo[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) { problems.push('새 저장소는 목록이어야 한다'); return []; }
    if (raw.length > MAX_NEW_REPOS) { problems.push(`새 저장소는 한 번에 ${MAX_NEW_REPOS}개까지다`); return []; }
    const dir = this.newRepoDir(projectId);
    const registered = this.d.repos.list(projectId);
    const out: PlanRepo[] = [];
    for (const x of raw) {
      const o: Record<string, unknown> = isObj(x) ? x : { name: x };
      const name = oneLine(o.name, 80);
      if (!REPO_NAME.test(name) || name.endsWith('.') || name.toLowerCase() === '.git') { problems.push(`새 저장소 이름 "${name}": 영문, 숫자, . _ - 만 쓸 수 있다 (60자까지, 폴더 이름이 된다)`); continue; }
      // 대소문자를 가리지 않는 디스크에서 같은 폴더가 되지 않게 한다.
      if (out.some((r) => r.name.toLowerCase() === name.toLowerCase())) { problems.push(`새 저장소 이름이 겹친다: "${name}"`); continue; }
      if (registered.some((r) => r.name.toLowerCase() === name.toLowerCase())) { problems.push(`"${name}" 은 이미 등록된 저장소의 이름이다. 그 저장소를 쓰거나 다른 이름을 써라`); continue; }
      if (existsSync(join(dir, name))) { problems.push(`새 저장소 "${name}": 그 자리에 이미 폴더나 파일이 있다 (${join(dir, name)}). 다른 이름을 써라`); continue; }
      out.push({ name, description: text(o.description, 500) });
    }
    return out;
  }

  /** 새 저장소 하나를 만든다: 폴더, git 초기화, README 와 첫 커밋 (작업 폴더를 만들려면 커밋이 하나 있어야 한다), 프로젝트에 등록. */
  private async createRepo(projectId: string, r: PlanRepo, made: { path: string; repo?: Repo }[]): Promise<Repo> {
    const dir = this.newRepoDir(projectId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, r.name);
    // 있으면 실패한다: 이미 있는 폴더를 건드리지 않는다. 여기서 만든 폴더만 되돌릴 때 지운다.
    mkdirSync(path);
    const entry: { path: string; repo?: Repo } = { path };
    made.push(entry);
    await this.d.git.raw(['-C', path, 'init', '-b', 'main']);
    writeFileSync(join(path, 'README.md'), `# ${r.name}\n${r.description ? `\n${r.description}\n` : ''}`);
    await this.d.git.raw(['-C', path, 'add', 'README.md']);
    const commit = ['commit', '-m', 'chore: initial commit (created by dure)'];
    // 사용자의 git 설정으로 커밋한다. 이름·이메일이 없거나 서명·hook 때문에 안 되면 두레의 이름으로 한다.
    await this.d.git.raw(['-C', path, ...commit]).catch(() => this.d.git.raw(['-C', path, '-c', 'user.name=dure', '-c', 'user.email=dure@localhost', '-c', 'commit.gpgsign=false', ...commit, '--no-verify']));
    entry.repo = this.d.repos.add(projectId, path);
    return entry.repo;
  }

  private todos(raw: unknown, where: string, problems: string[]): PlanTodo[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) { problems.push(`${where}: TODO 는 목록이어야 한다`); return []; }
    if (raw.length > MAX_TODOS) { problems.push(`${where}: TODO 가 너무 많다 (${MAX_TODOS}개까지)`); return []; }
    const out: PlanTodo[] = [];
    for (const x of raw) {
      const o: Record<string, unknown> = isObj(x) ? x : { title: x };
      const title = oneLine(o.title, 200);
      if (!title) { problems.push(`${where}: 제목이 없는 TODO 가 있다`); continue; }
      out.push({ title, detail: text(o.detail, 1000), assignee: o.assignee === 'user' ? 'user' : 'agent' });
    }
    return out;
  }

  /**
   * 계획안을 화면에 올릴 모양으로 다듬고 확인한다. 저장소는 이름으로도 받는다 (에이전트는 id 를 모른다).
   * 이름이 이미 있는 워크스페이스와 같으면 새로 만들지 않고 TODO 만 더하는 항목으로 본다.
   */
  private async clean(projectId: string, rawRepos: unknown, rawItems: unknown, rawProjectTodos: unknown): Promise<{ newRepos: PlanRepo[]; items: ProposalItem[]; projectTodos: PlanTodo[]; problems: string[] }> {
    const repos = this.d.repos.list(projectId);
    const workers = this.d.workspaces.list(projectId);
    const items: ProposalItem[] = [];
    const problems: string[] = [];
    const newRepos = this.newRepos(projectId, rawRepos, problems);
    const list = Array.isArray(rawItems) ? rawItems : [];
    if (list.length > MAX_ITEMS) problems.push(`워크스페이스는 한 번에 ${MAX_ITEMS}개까지다`);
    const names = new Set<string>();
    for (const [i, x] of list.slice(0, MAX_ITEMS).entries()) {
      const o = isObj(x) ? x : {};
      const name = oneLine(o.name, 60);
      if (!name) { problems.push(`${i + 1}번째 워크스페이스: 이름이 없다`); continue; }
      if (names.has(name)) { problems.push(`이름이 겹친다: "${name}"`); continue; }
      names.add(name);
      if (name === COORDINATOR_NAME) { problems.push(`"${COORDINATOR_NAME}" 은 조율 에이전트의 이름이라 쓸 수 없다`); continue; }
      const todos = this.todos(o.todos, `"${name}"`, problems);
      const role = oneLine(o.role, 500);
      const same = workers.filter((w) => w.name === name);
      if (same.length > 0) {
        // 이미 있는 워크스페이스: 만들지 않고 TODO 만 더한다.
        if (same.length > 1) { problems.push(`"${name}": 이름이 같은 워크스페이스가 둘 이상이라 어느 것인지 정할 수 없다`); continue; }
        items.push({ name, repoId: same[0]!.repoId, baseBranch: same[0]!.baseBranch, role: role || same[0]!.summary, todos, existing: true });
        continue;
      }
      const repoKey = oneLine(o.repo ?? o.repoId, 300);
      // 새 저장소: 아직 없으므로 이름으로 가리킨다. 첫 커밋이 있는 main 에서 시작한다.
      const fresh = newRepos.find((r) => r.name === repoKey || newRepoId(r.name) === repoKey);
      if (fresh) { items.push({ name, repoId: newRepoId(fresh.name), baseBranch: 'main', role, todos, existing: false }); continue; }
      if (isNewRepoId(repoKey)) { problems.push(`"${name}": 새 저장소 "${newRepoName(repoKey)}" 가 계획안에 없다`); continue; }
      const repo = repos.find((r) => r.id === repoKey) ?? repos.find((r) => r.name === repoKey) ?? repos.find((r) => r.path === repoKey);
      if (!repo) { problems.push(`"${name}": 등록된 저장소가 아니다 (${repoKey || '저장소 없음'}). 등록된 저장소: ${repos.map((r) => r.name).join(', ') || '없음'}. 맞는 저장소가 없으면 new_repos 에 새 저장소를 넣어라`); continue; }
      const branches = await this.d.git.listBranches(repo.path).catch(() => [] as string[]);
      const wanted = oneLine(o.base_branch ?? o.baseBranch, 200);
      let baseBranch = wanted;
      if (!wanted) baseBranch = await this.d.git.currentBranch(repo.path).catch(() => branches[0] ?? '');
      else if (!branches.includes(wanted)) { problems.push(`"${name}": 저장소 ${repo.name} 에 브랜치 ${wanted} 가 없다. 있는 브랜치: ${branches.slice(0, 20).join(', ')}`); continue; }
      if (!baseBranch) { problems.push(`"${name}": 저장소 ${repo.name} 의 기준 브랜치를 정할 수 없다`); continue; }
      items.push({ name, repoId: repo.id, baseBranch, role, todos, existing: false });
    }
    return { newRepos, items, projectTodos: this.todos(rawProjectTodos, '프로젝트 TODO', problems), problems };
  }

  /**
   * 조율 에이전트가 계획안을 올린다. 앞의 미결 계획안은 이것으로 바뀐다. 이때는 아무것도 만들지 않는다.
   * 문제가 있는 항목이 하나라도 있으면 올리지 않고 이유를 던진다 (에이전트가 고쳐서 다시 낸다).
   */
  async propose(projectId: string, raw: { summary?: unknown; new_repos?: unknown; workspaces?: unknown; project_todos?: unknown; note?: unknown }): Promise<Proposal> {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    if (this.d.service.isProjectClosed(projectId)) throw new Error('완료된 프로젝트다. 계획안을 올릴 수 없다.');
    const { newRepos, items, projectTodos, problems } = await this.clean(projectId, raw?.new_repos, raw?.workspaces, raw?.project_todos);
    // 사용자가 앞의 계획안을 승인해 만드는 중이면, 그 결과가 정해진 뒤에 올리게 한다.
    const current = this.pending(projectId);
    if (current && this.deciding.has(current.id)) throw new Error('사용자가 앞의 계획안을 승인해 만드는 중이다. 승인 알림을 받은 뒤에 다시 올려라.');
    if (problems.length) throw new Error(`계획안을 올리지 않았다. 고쳐서 다시 내라: ${problems.join(' / ')}`);
    if (newRepos.length === 0 && items.length === 0 && projectTodos.length === 0) throw new Error('계획안이 비어 있다. 워크스페이스나 TODO 를 넣어라.');
    const id = crypto.randomUUID();
    const plan = { summary: text(raw?.summary, MAX_SUMMARY), newRepos, items, projectTodos };
    this.d.db.transaction(() => {
      this.d.db.prepare("UPDATE proposals SET status = 'rejected' WHERE project_id = ? AND status = 'pending'").run(projectId);
      this.d.db.prepare('INSERT INTO proposals (id, project_id, status, items, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, projectId, 'pending', JSON.stringify(plan), text(raw?.note, 1000), Date.now());
    })();
    this.emit('changed', projectId);
    return this.pending(projectId)!;
  }

  /** 조율 에이전트에게 두레의 알림으로 알린다 (꺼져 있으면 이 알림으로 뜬다). */
  private tell(projectId: string, body: string): void {
    const coordinator = this.d.workspaces.coordinator(projectId);
    if (!coordinator) return;
    try {
      this.d.messages.send({ projectId, from: { kind: 'system' }, toWorkspaceId: coordinator.id, body, title: '계획안' });
    } catch { /* 알림 실패가 승인 결과를 바꾸면 안 된다 */ }
  }

  /**
   * 사용자가 계획안을 승인한다. decision 은 사용자가 검토 화면에서 고친 최종 계획이다.
   * 두레가 워크스페이스(작업 폴더와 브랜치)와 TODO 를 그대로 만든다. 전부 만들 수 있는지 먼저 확인하고,
   * 만드는 도중에 실패하면 만든 것을 되돌린다: 반쯤 만들어진 채로 두지 않는다.
   */
  async approve(proposalId: string, decision: PlanDecision): Promise<PlanResult> {
    if (this.deciding.has(proposalId)) throw new Error('이미 처리하는 중입니다.');
    this.deciding.add(proposalId);
    try {
      const r = this.d.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as Row | undefined;
      if (!r || r.status !== 'pending') throw new Error('승인을 기다리는 계획안이 아닙니다.');
      if (this.d.service.isProjectClosed(r.project_id)) throw new Error('완료된 프로젝트입니다.');
      const { newRepos, items, projectTodos, problems } = await this.clean(r.project_id, decision?.newRepos, decision?.items, decision?.projectTodos);
      if (problems.length) throw new Error(problems.join(' / '));
      if (newRepos.length === 0 && items.length === 0 && projectTodos.length === 0) throw new Error('만들 것이 없습니다. 거절하려면 "거절" 을 누르세요.');
      const madeRepos: { path: string; repo?: Repo }[] = [];
      const created: Workspace[] = [];
      const todoIds: string[] = [];
      try {
        // 저장소가 먼저다: 워크스페이스는 그 저장소에서 만든다.
        for (const nr of newRepos) {
          const repo = await this.createRepo(r.project_id, nr, madeRepos);
          for (const it of items) if (it.repoId === newRepoId(nr.name)) it.repoId = repo.id;
        }
        const targets = new Map<string, Workspace>();
        for (const it of items) {
          if (it.existing) { targets.set(it.name, this.d.workspaces.list(r.project_id).find((w) => w.name === it.name)!); continue; }
          // 권한은 설정의 기본값을 따르지 않고 "승인 필요" 로 만든다: 검토 화면에 보이지 않은 채 승인 생략으로 돌지 않게 한다.
          const ws = await this.d.service.create({ projectId: r.project_id, repoId: it.repoId, name: it.name, baseBranch: it.baseBranch, agentKind: 'claude', permissionMode: 'ask' });
          if (it.role) this.d.workspaces.update(ws.id, { summary: it.role });
          const fresh = this.d.workspaces.get(ws.id) ?? ws;
          created.push(fresh);
          targets.set(it.name, fresh);
        }
        for (const it of items) for (const t of it.todos) todoIds.push(this.d.todos.add({ projectId: r.project_id, workspaceId: targets.get(it.name)!.id, ...t }, 'agent').id);
        for (const t of projectTodos) todoIds.push(this.d.todos.add({ projectId: r.project_id, workspaceId: null, ...t }, 'agent').id);
      } catch (e) {
        for (const id of todoIds) { try { this.d.todos.remove(id, { actor: 'user' }); } catch { /* 이미 없음 */ } }
        // 되돌리지 못한 것은 숨기지 않는다: 무엇이 남았는지 알려야 사용자가 치울 수 있다.
        const left: string[] = [];
        for (const ws of created) await this.d.service.discard(ws.id).catch(() => { left.push(`워크스페이스 ${ws.name}`); });
        // 여기서 만든 저장소도 치운다. 이 승인에서 새로 만든 빈 폴더만 지운다 (mkdir 이 성공한 것만 목록에 있다).
        const root = this.d.repoRoot + sep;
        for (const m of madeRepos.reverse()) {
          try {
            if (m.repo) this.d.repos.remove(m.repo.id);
            if (m.path.startsWith(root)) rmSync(m.path, { recursive: true, force: true });
            for (const it of items) if (m.repo && it.repoId === m.repo.id) it.repoId = newRepoId(m.repo.name);
          } catch { left.push(`저장소 ${basename(m.path)}`); }
        }
        const why = e instanceof Error ? e.message : (e as { detail?: string })?.detail ?? String(e);
        throw new Error(left.length ? `${why} (만들던 것을 되돌리지 못했습니다. 남은 것: ${left.join(', ')}. "현황" 에서 지운 뒤 다시 승인하세요)` : why);
      }
      this.d.db.prepare("UPDATE proposals SET status = 'approved', items = ? WHERE id = ? AND status = 'pending'")
        .run(JSON.stringify({ summary: toProposal(r).summary, newRepos, items, projectTodos }), proposalId);
      this.emit('changed', r.project_id);
      const repoName = (id: string): string => this.d.repos.get(id)?.name ?? '';
      this.tell(r.project_id, [
        '사용자가 계획안을 검토하고 승인했다. 두레가 아래를 만들었다. 사용자가 고쳤을 수 있으니 이 목록이 최종이다.',
        ...madeRepos.map((m) => `- 새 저장소 "${basename(m.path)}" (${m.path}): 만들어 프로젝트에 등록했다. README.md 와 첫 커밋만 있다.`),
        ...items.map((it) => `- 워크스페이스 "${it.name}" (저장소 ${repoName(it.repoId)}${it.existing ? ', 이미 있던 것' : ', 새로 만듦'})${it.role ? `: ${it.role}` : ''}${it.todos.length ? `\n${it.todos.map((t) => `  - TODO${t.assignee === 'user' ? '(사용자 몫)' : ''}: ${t.title}`).join('\n')}` : ''}`),
        ...(projectTodos.length ? ['- 프로젝트 TODO:', ...projectTodos.map((t) => `  - ${t.assignee === 'user' ? '(사용자 몫) ' : ''}${t.title}`)] : []),
        'TODO 는 이미 적혀 있다. 다시 적지 마라. 이제 각 워크스페이스에 message_send 로 작업을 시작하라고 알려라 (할 일은 그 워크스페이스의 TODO 에 있다고 알려 주면 된다).',
      ].join('\n'));
      return { repos: madeRepos.flatMap((m) => (m.repo ? [m.repo] : [])), created, todos: todoIds.length };
    } finally {
      this.deciding.delete(proposalId);
    }
  }

  /** 사용자가 계획안을 거절한다. 이유가 있으면 조율 에이전트에게 전한다. */
  reject(proposalId: string, reason?: string): void {
    if (this.deciding.has(proposalId)) throw new Error('이미 처리하는 중입니다.');
    const r = this.d.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as Row | undefined;
    if (!r || r.status !== 'pending') throw new Error('승인을 기다리는 계획안이 아닙니다.');
    this.d.db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(proposalId);
    this.emit('changed', r.project_id);
    const why = oneLine(reason, 500);
    this.tell(r.project_id, `사용자가 계획안을 거절했다. 아무것도 만들어지지 않았다.${why ? ` 이유: ${why}` : ''} 사용자의 뜻을 확인하고 필요하면 고쳐서 다시 올려라.`);
  }

  /**
   * 사용자가 고른 기획서 파일을 읽는다. 글 파일이면 내용을, 아니면(PDF 등) 경로만 돌려준다.
   * 화면에서 사용자가 직접 고른 파일만 받는다.
   */
  readSpec(path: string): SpecFile {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error('파일을 찾을 수 없습니다.');
    const fd = openSync(path, 'r');
    try {
      const size = statSync(path).size;
      const buf = Buffer.alloc(Math.min(size, MAX_SPEC_BYTES));
      const n = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n);
      // 0 바이트가 있으면 글 파일이 아니다 (PDF, 문서 파일, 이미지).
      const binary = head.includes(0);
      // 잘린 끝의 깨진 글자는 뺀다.
      const body = binary ? null : head.toString('utf8').replace(/�+$/, '');
      return { path, name: basename(path), text: body, truncated: !binary && size > MAX_SPEC_BYTES };
    } finally {
      closeSync(fd);
    }
  }
}
