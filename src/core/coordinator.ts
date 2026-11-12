import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { folderRepoId, isFolderRepoId, isNewRepoId, newRepoId, newRepoName, validRepoName } from '@shared/plan';
import type { PlanDecision, PlanFolder, PlanRepo, PlanResult, PlanTodo, Proposal, ProposalItem, Repo, Settings, SpecFile, Workspace } from '@shared/types';
import type { Git } from './git';
import type { MessageService } from './messages';
import { expandHome } from './settings';
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
  let plan: { summary?: unknown; newRepos?: unknown; addRepos?: unknown; items?: unknown; projectTodos?: unknown } = {};
  try { const v = JSON.parse(r.items) as unknown; plan = Array.isArray(v) ? { items: v } : isObj(v) ? v : {}; } catch { /* 빈 계획 */ }
  return {
    id: r.id, projectId: r.project_id, status: r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending',
    summary: typeof plan.summary === 'string' ? plan.summary : '',
    newRepos: Array.isArray(plan.newRepos) ? plan.newRepos as PlanRepo[] : [],
    addRepos: Array.isArray(plan.addRepos) ? plan.addRepos as PlanFolder[] : [],
    items: Array.isArray(plan.items) ? (plan.items as ProposalItem[]).map((i) => ({ ...i, todos: Array.isArray(i.todos) ? i.todos : [], existing: i.existing === true, owner: typeof i.owner === 'string' ? i.owner : '' })) : [],
    projectTodos: Array.isArray(plan.projectTodos) ? plan.projectTodos as PlanTodo[] : [],
    note: r.note, createdAt: r.created_at,
  };
}

/** 그 자리에 무엇이든 있는가. 끊어진 심볼릭 링크도 있는 것으로 본다. */
const taken = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
/** 새 저장소를 만드는 git 명령 하나가 기다릴 시간. 서명 프로그램이나 hook 이 입력을 기다리며 멈추면 승인이 끝나지 않는다 */
const GIT_STEP_MS = 30_000;
const within = <T>(p: Promise<T>, what: string): Promise<T> => new Promise<T>((done, fail) => {
  const timer = setTimeout(() => fail(new Error(`${what} 이(가) 시간 안에 끝나지 않았습니다.`)), GIT_STEP_MS);
  p.then((v) => { clearTimeout(timer); done(v); }, (e) => { clearTimeout(timer); fail(e); });
});

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
    /**
     * 일을 함께하는 사람에게 나눠 주는 쪽 (배정). 없으면 계획안의 모든 일을 내 PC 에 만든다.
     * people: 나눠 줄 수 있는 사람. send: 보내고 그 배정의 id 를 돌려준다 (닿지 않으면 던진다). cancel: 보낸 것을 거둔다
     */
    assign?: {
      people(projectId: string): { peerId: string; name: string }[];
      send(projectId: string, peerId: string, a: { summary: string; items: { name: string; role: string; todos: PlanTodo[] }[] }): Promise<string>;
      cancel(assignmentId: string): Promise<void>;
      /** 함께하는 사람들에게 기획서 정리를 보낸다 (skip: 이미 배정으로 받은 사람) */
      brief?(projectId: string, summary: string, skip: string[]): Promise<{ sent: string[]; failed: string[] }>;
    };
    /** 새 저장소를 만드는 상위 폴더의 기본값. 설정에 값이 있으면 그것을 쓴다. 그 아래 프로젝트 이름의 폴더에 만든다 */
    repoRoot: string;
    settings(): Settings;
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

  /** 새 저장소를 만드는 상위 폴더: 설정에 있으면 그곳, 없으면 기본 위치. */
  private repoRoot(): string {
    const set = this.d.settings().repoRoot;
    return resolve(set ? expandHome(set) : this.d.repoRoot);
  }

  /**
   * 등록된 저장소가 바뀌었다. 조율 에이전트는 띄울 때의 저장소만 읽을 수 있으므로, 쉬는 중이면 다시 띄운다 (대화는 이어진다).
   * 꺼져 있으면 다음에 뜰 때 반영된다. 일하는 중이면 건드리지 않는다.
   */
  async reload(projectId: string): Promise<'reloaded' | 'busy' | 'off'> {
    const c = this.d.workspaces.coordinator(projectId);
    if (!c || !this.d.service.isAgentRunning(c.id)) return 'off';
    if (this.d.workspaces.get(c.id)?.status !== 'idle') return 'busy';
    await this.d.service.stopAgent(c.id);
    await this.d.service.startAgent(c.id, { cols: 120, rows: 40 });
    return 'reloaded';
  }

  /** 이 프로젝트의 새 저장소가 만들어질 폴더. */
  newRepoDir(projectId: string): string {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    return join(this.repoRoot(), slugify(project.name));
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
      if (!validRepoName(name)) { problems.push(`새 저장소 이름 "${name}": 영문, 숫자, . _ - 만 쓸 수 있다 (60자까지, 폴더 이름이 된다)`); continue; }
      // 대소문자를 가리지 않는 디스크에서 같은 폴더가 되지 않게 한다.
      if (out.some((r) => r.name.toLowerCase() === name.toLowerCase())) { problems.push(`새 저장소 이름이 겹친다: "${name}"`); continue; }
      if (registered.some((r) => r.name.toLowerCase() === name.toLowerCase())) { problems.push(`"${name}" 은 이미 등록된 저장소의 이름이다. 그 저장소를 쓰거나 다른 이름을 써라`); continue; }
      if (taken(join(dir, name))) { problems.push(`새 저장소 "${name}": 그 자리에 이미 폴더나 파일이 있다 (${join(dir, name)}). 다른 이름을 써라`); continue; }
      out.push({ name, description: text(o.description, 500) });
    }
    return out;
  }

  /**
   * 계획안이 등록하자고 하는 폴더를 확인한다: PC 에 있는 git 저장소여야 한다. 저장소의 맨 위 폴더로 맞춘다.
   * 이미 등록된 폴더면 등록할 것에 넣지 않고 그 저장소를 쓰게 한다 (aliases: 적어 온 경로 → 등록된 저장소).
   */
  private async folders(projectId: string, raw: unknown, newRepos: PlanRepo[], problems: string[]): Promise<{ addRepos: PlanFolder[]; aliases: Map<string, Repo> }> {
    const aliases = new Map<string, Repo>();
    if (raw === undefined || raw === null) return { addRepos: [], aliases };
    if (!Array.isArray(raw)) { problems.push('등록할 저장소 폴더는 목록이어야 한다'); return { addRepos: [], aliases }; }
    if (raw.length > MAX_NEW_REPOS) { problems.push(`등록할 저장소 폴더는 한 번에 ${MAX_NEW_REPOS}개까지다`); return { addRepos: [], aliases }; }
    const registered = this.d.repos.list(projectId);
    const out: PlanFolder[] = [];
    for (const x of raw) {
      const given = expandHome(oneLine(isObj(x) ? x.path : x, 1000));
      if (!given || !isAbsolute(given)) { problems.push(`등록할 저장소 폴더 "${given}": 절대 경로로 적어라`); continue; }
      if (!existsSync(given)) { problems.push(`등록할 저장소 폴더 "${given}": 그런 폴더가 없다`); continue; }
      if (!(await this.d.git.isGitRepo(given).catch(() => false))) { problems.push(`등록할 저장소 폴더 "${given}": git 저장소가 아니다. 새로 만들 것이면 new_repos 에 넣어라`); continue; }
      const top = (await this.d.git.raw(['-C', given, 'rev-parse', '--show-toplevel']).catch(() => '')).trim() || resolve(given);
      const known = registered.find((r) => r.path === top);
      if (known) { aliases.set(given, known); aliases.set(top, known); continue; }
      if (out.some((f) => f.path === top)) continue;
      const name = basename(top);
      const clash = (n: string): boolean => n.toLowerCase() === name.toLowerCase();
      if (registered.some((r) => clash(r.name)) || out.some((f) => clash(f.name)) || newRepos.some((r) => clash(r.name))) { problems.push(`등록할 저장소 폴더 "${top}": 같은 이름(${name})의 저장소가 이미 있다`); continue; }
      const remote = (await this.d.git.raw(['-C', top, 'remote', 'get-url', 'origin']).catch(() => '')).trim().slice(0, 300);
      out.push({ path: top, name, remote });
      aliases.delete(given);
    }
    return { addRepos: out, aliases };
  }

  /** 새 저장소 하나를 만든다: 폴더, git 초기화, README 와 첫 커밋 (작업 폴더를 만들려면 커밋이 하나 있어야 한다), 프로젝트에 등록. */
  private async createRepo(projectId: string, r: PlanRepo, made: { path: string; repo?: Repo }[]): Promise<Repo> {
    const dir = this.newRepoDir(projectId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, r.name);
    // 있으면 실패한다: 이미 있는 폴더를 건드리지 않는다. 여기서 만든 폴더만 되돌릴 때 지운다.
    try { mkdirSync(path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`새 저장소 "${r.name}": 그 자리에 이미 폴더나 파일이 있습니다 (${path}).`);
      throw e;
    }
    const entry: { path: string; repo?: Repo } = { path };
    made.push(entry);
    const git = (args: string[]): Promise<string> => within(this.d.git.raw(['-C', path, ...args]), `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}`);
    await git(['init', '-b', 'main']);
    writeFileSync(join(path, 'README.md'), `# ${r.name}\n${r.description ? `\n${r.description}\n` : ''}`);
    // -f: 사용자의 전역 무시 규칙이 README 를 무시해도 넣는다.
    await git(['add', '-f', 'README.md']);
    const commit = ['commit', '-m', 'chore: initial commit (created by dure)'];
    // 사용자의 git 설정으로 커밋한다. 서명이나 hook 때문에 안 되면 그것 없이 한다. 이름·이메일은 설정이 없을 때만 두레의 것을 쓴다.
    await git(commit).catch(async () => {
      const has = async (key: string): Promise<boolean> => Boolean((await git(['config', key]).catch(() => '')).trim());
      const who = [...(await has('user.name') ? [] : ['-c', 'user.name=dure']), ...(await has('user.email') ? [] : ['-c', 'user.email=dure@localhost'])];
      await git([...who, '-c', 'commit.gpgsign=false', ...commit, '--no-verify']);
    });
    entry.repo = this.d.repos.add(projectId, path);
    return entry.repo;
  }

  /** 빈 저장소 하나를 만들어 프로젝트에 등록한다 (받은 배정을 수락할 때, 맞는 저장소가 없으면 쓴다). */
  async createEmptyRepo(projectId: string, name: string, description: string): Promise<Repo> {
    const problems: string[] = [];
    const [repo] = this.newRepos(projectId, [{ name, description }], problems);
    if (problems.length || !repo) throw new Error(problems.join(' / ') || '새 저장소를 만들 수 없습니다.');
    const made: { path: string; repo?: Repo }[] = [];
    try {
      return await this.createRepo(projectId, repo, made);
    } catch (e) {
      // 이 호출에서 만든 폴더만 치운다.
      const root = this.repoRoot() + sep;
      for (const m of made) { try { if (m.repo) this.d.repos.remove(m.repo.id); if (m.path.startsWith(root)) rmSync(m.path, { recursive: true, force: true }); } catch { /* 남은 것은 오류 글로 알 수 있다 */ } }
      throw e instanceof Error ? e : new Error((e as { detail?: string })?.detail ?? String(e));
    }
  }

  /** 저장소에서 지금 체크아웃된 브랜치. */
  currentBranch(repoPath: string): Promise<string> { return this.d.git.currentBranch(repoPath); }

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
  private async clean(projectId: string, rawRepos: unknown, rawItems: unknown, rawProjectTodos: unknown, rawFolders?: unknown): Promise<{ newRepos: PlanRepo[]; addRepos: PlanFolder[]; items: ProposalItem[]; projectTodos: PlanTodo[]; problems: string[] }> {
    const repos = this.d.repos.list(projectId);
    const workers = this.d.workspaces.list(projectId);
    const items: ProposalItem[] = [];
    const problems: string[] = [];
    const newRepos = this.newRepos(projectId, rawRepos, problems);
    const { addRepos, aliases } = await this.folders(projectId, rawFolders, newRepos, problems);
    const people = this.d.assign?.people(projectId) ?? [];
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
      // 맡을 사람: 함께하는 사람의 이름이나 id. 그 사람에게 배정으로 보낸다 (그 사람의 저장소는 모른다: 저장소는 그 사람이 고른다).
      const ownerKey = oneLine(o.owner, 80);
      if (ownerKey) {
        const who = people.filter((p) => p.peerId === ownerKey || p.name === ownerKey);
        if (who.length !== 1) { problems.push(`"${name}": 맡을 사람 "${ownerKey}" 을(를) 찾을 수 없다. 나눠 줄 수 있는 사람: ${people.map((p) => p.name).join(', ') || '없음 (일을 나눠 주는 것은 프로젝트를 함께 연 사람만 할 수 있다. 사용자가 이 프로젝트를 함께하는 프로젝트로 열고 사람을 초대해야 한다)'}`); continue; }
        items.push({ name, repoId: '', baseBranch: '', role, todos, existing: false, owner: who[0]!.peerId });
        continue;
      }
      const same = workers.filter((w) => w.name === name);
      if (same.length > 0) {
        // 이미 있는 워크스페이스: 만들지 않고 TODO 만 더한다.
        if (same.length > 1) { problems.push(`"${name}": 이름이 같은 워크스페이스가 둘 이상이라 어느 것인지 정할 수 없다`); continue; }
        items.push({ name, repoId: same[0]!.repoId, baseBranch: same[0]!.baseBranch, role: role || same[0]!.summary, todos, existing: true, owner: '' });
        continue;
      }
      const repoKey = oneLine(o.repo ?? o.repoId, 300);
      // 새 저장소: 아직 없으므로 이름으로 가리킨다. 첫 커밋이 있는 main 에서 시작한다.
      const fresh = newRepos.find((r) => r.name === repoKey || newRepoId(r.name) === repoKey);
      if (fresh) { items.push({ name, repoId: newRepoId(fresh.name), baseBranch: 'main', role, todos, existing: false, owner: '' }); continue; }
      if (isNewRepoId(repoKey)) { problems.push(`"${name}": 새 저장소 "${newRepoName(repoKey)}" 가 계획안에 없다`); continue; }
      // 등록할 폴더: 아직 등록되지 않았으므로 경로로 가리킨다.
      const folder = addRepos.find((f) => f.name === repoKey || f.path === repoKey || folderRepoId(f.path) === repoKey);
      if (!folder && isFolderRepoId(repoKey)) { problems.push(`"${name}": 그 저장소 폴더가 계획안의 등록할 저장소에 없다. 저장소를 다시 골라라`); continue; }
      const found = folder ? undefined : repos.find((r) => r.id === repoKey) ?? repos.find((r) => r.name === repoKey) ?? repos.find((r) => r.path === repoKey) ?? aliases.get(expandHome(repoKey));
      if (!folder && !found) { problems.push(`"${name}": 등록된 저장소가 아니다 (${repoKey || '저장소 없음'}). 등록된 저장소: ${repos.map((r) => r.name).join(', ') || '없음'}. PC 에 이미 있는 저장소 폴더면 add_repos 에 그 경로를, 없으면 new_repos 에 새 저장소를 넣어라`); continue; }
      const repo = folder ? { id: folderRepoId(folder.path), name: folder.name, path: folder.path } : found!;
      const branches = await this.d.git.listBranches(repo.path).catch(() => [] as string[]);
      const wanted = oneLine(o.base_branch ?? o.baseBranch, 200);
      let baseBranch = wanted;
      if (!wanted) baseBranch = await this.d.git.currentBranch(repo.path).catch(() => branches[0] ?? '');
      else if (!branches.includes(wanted)) { problems.push(`"${name}": 저장소 ${repo.name} 에 브랜치 ${wanted} 가 없다. 있는 브랜치: ${branches.slice(0, 20).join(', ')}`); continue; }
      if (!baseBranch) { problems.push(`"${name}": 저장소 ${repo.name} 의 기준 브랜치를 정할 수 없다`); continue; }
      items.push({ name, repoId: repo.id, baseBranch, role, todos, existing: false, owner: '' });
    }
    return { newRepos, addRepos, items, projectTodos: this.todos(rawProjectTodos, '프로젝트 TODO', problems), problems };
  }

  /**
   * 조율 에이전트가 계획안을 올린다. 앞의 미결 계획안은 이것으로 바뀐다. 이때는 아무것도 만들지 않는다.
   * 문제가 있는 항목이 하나라도 있으면 올리지 않고 이유를 던진다 (에이전트가 고쳐서 다시 낸다).
   */
  /** 함께하는 사람들 (일을 나눠 줄 수 있는 사람). */
  people(projectId: string): { peerId: string; name: string }[] { return this.d.assign?.people(projectId) ?? []; }

  async propose(projectId: string, raw: { summary?: unknown; new_repos?: unknown; add_repos?: unknown; workspaces?: unknown; project_todos?: unknown; note?: unknown }): Promise<Proposal> {
    const project = this.d.projects.get(projectId);
    if (!project) throw new Error(`프로젝트가 없습니다: ${projectId}`);
    if (this.d.service.isProjectClosed(projectId)) throw new Error('완료된 프로젝트다. 계획안을 올릴 수 없다.');
    const { newRepos, addRepos, items, projectTodos, problems } = await this.clean(projectId, raw?.new_repos, raw?.workspaces, raw?.project_todos, raw?.add_repos);
    // 사용자가 앞의 계획안을 승인해 만드는 중이면, 그 결과가 정해진 뒤에 올리게 한다.
    const current = this.pending(projectId);
    if (current && this.deciding.has(current.id)) throw new Error('사용자가 앞의 계획안을 승인해 만드는 중이다. 승인 알림을 받은 뒤에 다시 올려라.');
    if (problems.length) throw new Error(`계획안을 올리지 않았다. 고쳐서 다시 내라: ${problems.join(' / ')}`);
    if (newRepos.length === 0 && addRepos.length === 0 && items.length === 0 && projectTodos.length === 0) throw new Error('계획안이 비어 있다. 워크스페이스나 TODO 를 넣어라.');
    const id = crypto.randomUUID();
    const plan = { summary: text(raw?.summary, MAX_SUMMARY), newRepos, addRepos, items, projectTodos };
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
      const { newRepos, addRepos, items, projectTodos, problems } = await this.clean(r.project_id, decision?.newRepos, decision?.items, decision?.projectTodos, decision?.addRepos);
      if (problems.length) throw new Error(problems.join(' / '));
      if (newRepos.length === 0 && addRepos.length === 0 && items.length === 0 && projectTodos.length === 0) throw new Error('만들 것이 없습니다. 거절하려면 "거절" 을 누르세요.');
      const people = this.d.assign?.people(r.project_id) ?? [];
      const madeRepos: { path: string; repo?: Repo }[] = [];
      // 이 승인에서 등록한, 이미 있던 폴더. 되돌릴 때 등록만 푼다 (폴더는 건드리지 않는다).
      const added: Repo[] = [];
      const created: Workspace[] = [];
      const todoIds: string[] = [];
      // 남의 몫과 내 몫을 가른다. 남의 몫은 그 사람에게 배정으로 보낸다.
      const all = items;
      const mine = all.filter((it) => !it.owner);
      const summary = toProposal(r).summary;
      const sent: string[] = [];
      const byOwner = new Map<string, ProposalItem[]>();
      for (const it of all) if (it.owner) byOwner.set(it.owner, [...(byOwner.get(it.owner) ?? []), it]);
      // 먼저 보낸다: 닿지 않는 사람이 있으면 아무것도 만들지 않는다 (일부만 나눠진 상태를 만들지 않는다).
      try {
        for (const [peerId, list] of byOwner) sent.push(await this.d.assign!.send(r.project_id, peerId, { summary, items: list.map((it) => ({ name: it.name, role: it.role, todos: it.todos })) }));
      } catch (e) {
        for (const id of sent) await this.d.assign!.cancel(id).catch(() => undefined);
        throw new Error(`일을 나눠 주지 못해 아무것도 만들지 않았습니다: ${e instanceof Error ? e.message : String(e)}`);
      }
      {
        const items = mine;
      try {
        // 저장소가 먼저다: 워크스페이스는 그 저장소에서 만든다.
        for (const f of addRepos) {
          const repo = this.d.repos.add(r.project_id, f.path);
          added.push(repo);
          for (const it of items) if (it.repoId === folderRepoId(f.path)) it.repoId = repo.id;
        }
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
        for (const it of items) for (const t of it.todos) todoIds.push(this.d.todos.add({ projectId: r.project_id, workspaceId: targets.get(it.name)!.id, title: t.title, detail: t.detail, assignee: t.assignee }, 'agent').id);
        for (const t of projectTodos) todoIds.push(this.d.todos.add({ projectId: r.project_id, workspaceId: null, ...t }, 'agent').id);
      } catch (e) {
        // 보낸 배정도 거둔다.
        for (const id of sent) await this.d.assign!.cancel(id).catch(() => undefined);
        for (const id of todoIds) { try { this.d.todos.remove(id, { actor: 'user' }); } catch { /* 이미 없음 */ } }
        // 되돌리지 못한 것은 숨기지 않는다: 무엇이 남았는지 알려야 사용자가 치울 수 있다.
        const left: string[] = [];
        for (const ws of created) await this.d.service.discard(ws.id).catch(() => { left.push(`워크스페이스 ${ws.name}`); });
        // 여기서 만든 저장소도 치운다. 이 승인에서 새로 만든 빈 폴더만 지운다 (mkdir 이 성공한 것만 목록에 있다).
        const root = this.repoRoot() + sep;
        for (const m of madeRepos.reverse()) {
          try {
            if (m.repo) this.d.repos.remove(m.repo.id);
            if (!m.path.startsWith(root)) throw new Error('새 저장소 폴더 밖');
            rmSync(m.path, { recursive: true, force: true });
            for (const it of items) if (m.repo && it.repoId === m.repo.id) it.repoId = newRepoId(m.repo.name);
          } catch { left.push(`저장소 폴더 ${m.path}`); }
        }
        for (const repo of added.reverse()) {
          try { this.d.repos.remove(repo.id); for (const it of items) if (it.repoId === repo.id) it.repoId = folderRepoId(repo.path); } catch { left.push(`저장소 등록 ${repo.name}`); }
        }
        const why = e instanceof Error ? e.message : (e as { detail?: string })?.detail ?? String(e);
        throw new Error(left.length ? `${why} (만들던 것을 되돌리지 못했습니다. 남은 것: ${left.join(', ')}. "현황" 에서 지운 뒤 다시 승인하세요)` : why);
      }
      }
      this.d.db.prepare("UPDATE proposals SET status = 'approved', items = ? WHERE id = ? AND status = 'pending'")
        .run(JSON.stringify({ summary, newRepos, addRepos, items: all, projectTodos }), proposalId);
      this.emit('changed', r.project_id);
      // 일을 받지 않는 사람에게도 기획서 정리를 보낸다 (사용자가 골랐을 때). 못 보내도 승인은 그대로다.
      const briefed = decision?.shareSummary && summary && this.d.assign?.brief ? await this.d.assign.brief(r.project_id, summary, [...byOwner.keys()]).catch(() => ({ sent: [], failed: [] })) : { sent: [], failed: [] };
      // 새 저장소를 조율 에이전트가 읽을 수 있게 다시 띄운다. 못 하면 알림에 적는다.
      const reloaded = madeRepos.length || added.length ? await this.reload(r.project_id).catch(() => 'busy' as const) : 'off';
      const repoName = (id: string): string => this.d.repos.get(id)?.name ?? '';
      this.tell(r.project_id, [
        '사용자가 계획안을 검토하고 승인했다. 두레가 아래를 만들었다. 사용자가 고쳤을 수 있으니 이 목록이 최종이다.',
        ...added.map((repo) => `- 저장소 "${repo.name}" (${repo.path}): 이미 있던 폴더를 이 프로젝트에 등록했다.`),
        ...madeRepos.map((m) => `- 새 저장소 "${basename(m.path)}" (${m.path}): 만들어 프로젝트에 등록했다. README.md 와 첫 커밋만 있다.`),
        ...mine.map((it) => `- 워크스페이스 "${it.name}" (저장소 ${repoName(it.repoId)}${it.existing ? ', 이미 있던 것' : ', 새로 만듦'})${it.role ? `: ${it.role}` : ''}${it.todos.length ? `\n${it.todos.map((t) => `  - TODO${t.assignee === 'user' ? '(사용자 몫)' : ''}: ${t.title}`).join('\n')}` : ''}`),
        ...(projectTodos.length ? ['- 프로젝트 TODO:', ...projectTodos.map((t) => `  - ${t.assignee === 'user' ? '(사용자 몫) ' : ''}${t.title}`)] : []),
        ...(reloaded === 'busy' ? ['새 저장소의 파일은 네가 다시 떠야 읽을 수 있다. 읽어야 하면 사용자에게 조율 에이전트를 껐다 켜 달라고 하라.'] : []),
        ...[...byOwner].map(([peerId, list]) => `- ${people.find((p) => p.peerId === peerId)?.name ?? '다른 사람'} 에게 나눠 줬다 (아직 만들어지지 않았다. 그 사람이 자기 두레에서 수락해야 만들어진다. 수락하거나 거절하면 두레가 알려 준다): ${list.map((it) => `"${it.name}"`).join(', ')}`),
        ...(briefed.sent.length ? [`- 기획서 정리를 ${briefed.sent.join(', ')} 에게도 보냈다 (일은 맡기지 않았다. 그 사람이 자료로 받으면 그쪽 에이전트가 읽을 수 있다).`] : []),
        ...(briefed.failed.length ? [`- ${briefed.failed.join(', ')} 에게는 기획서 정리가 닿지 않았다 (꺼져 있다).`] : []),
        mine.length ? 'TODO 는 이미 적혀 있다. 다시 적지 마라. 이제 내 PC 의 각 워크스페이스에 message_send 로 작업을 시작하라고 알려라 (할 일은 그 워크스페이스의 TODO 에 있다고 알려 주면 된다).' : '내 PC 에 만든 워크스페이스는 없다. 나눠 준 사람들의 수락을 기다려라.',
      ].join('\n'));
      return { assigned: sent.length, repos: [...added, ...madeRepos.flatMap((m) => (m.repo ? [m.repo] : []))], created, todos: todoIds.length };
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
