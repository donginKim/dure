import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import type { Project, Repo, Workspace } from '@shared/types';

interface ProjectRow { id: string; name: string; created_at: number; status: string; completed_at: number | null }
interface RepoRow { id: string; project_id: string; name: string; path: string; verify_command?: string }
interface WorkspaceRow {
  id: string; project_id: string; repo_id: string; name: string; name_locked: number; summary: string;
  branch: string; base_branch: string; worktree_path: string; agent_kind: string; permission_mode: string;
  status: string; token: string; created_at: number; engine: string; session_id: string | null; role: string;
}

const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, createdAt: r.created_at, status: r.status === 'done' ? 'done' : 'active', completedAt: r.completed_at });
const toRepo = (r: RepoRow): Repo => ({ id: r.id, projectId: r.project_id, name: r.name, path: r.path, verifyCommand: r.verify_command ?? '' });
// 토큰은 일부러 옮기지 않는다. 화면으로 나가는 객체에 들어가면 안 된다.
const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id, projectId: r.project_id, role: r.role === 'coordinator' ? 'coordinator' : 'worker', repoId: r.repo_id, name: r.name, nameLocked: r.name_locked === 1,
  summary: r.summary, branch: r.branch, baseBranch: r.base_branch, worktreePath: r.worktree_path,
  agentKind: r.agent_kind as Workspace['agentKind'], permissionMode: r.permission_mode as Workspace['permissionMode'],
  engine: r.engine as Workspace['engine'], status: r.status as Workspace['status'], createdAt: r.created_at,
});

export class ProjectStore {
  constructor(private readonly db: Database.Database) {}

  create(name: string): Project {
    const p: Project = { id: crypto.randomUUID(), name, createdAt: Date.now(), status: 'active', completedAt: null };
    this.db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(p.id, p.name, p.createdAt);
    return p;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all() as ProjectRow[]).map(toProject);
  }

  get(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r && toProject(r);
  }

  /** 완료 처리하거나 다시 연다. */
  setStatus(id: string, status: Project['status']): Project {
    this.db.prepare('UPDATE projects SET status = ?, completed_at = ? WHERE id = ?').run(status, status === 'done' ? Date.now() : null, id);
    const p = this.get(id);
    if (!p) throw new Error(`프로젝트가 없습니다: ${id}`);
    return p;
  }

  remove(id: string): void {
    // 워크스페이스가 저장소를 RESTRICT 로 참조하므로 워크스페이스를 먼저 지운다.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspaces WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
  }
}

export class RepoStore {
  constructor(private readonly db: Database.Database) {}

  add(projectId: string, path: string): Repo {
    const r: Repo = { id: crypto.randomUUID(), projectId, name: basename(path), path, verifyCommand: '' };
    this.db.prepare('INSERT INTO repos (id, project_id, name, path) VALUES (?, ?, ?, ?)').run(r.id, r.projectId, r.name, r.path);
    return r;
  }

  /** 사용자가 등록한 저장소. 두레가 안에서 쓰는 것(조율 에이전트의 폴더)은 빼고 준다. */
  list(projectId: string): Repo[] {
    return (this.db.prepare('SELECT * FROM repos WHERE project_id = ? AND internal = 0 ORDER BY rowid').all(projectId) as RepoRow[]).map(toRepo);
  }

  /** 두레가 안에서 쓰는 폴더를 저장소 자리에 적어 둔다 (조율 에이전트). 이미 있으면 그것을 돌려준다. */
  addInternal(projectId: string, path: string): Repo {
    const found = this.db.prepare('SELECT * FROM repos WHERE project_id = ? AND path = ?').get(projectId, path) as RepoRow | undefined;
    if (found) return toRepo(found);
    const r: Repo = { id: crypto.randomUUID(), projectId, name: basename(path), path, verifyCommand: '' };
    this.db.prepare('INSERT INTO repos (id, project_id, name, path, internal) VALUES (?, ?, ?, ?, 1)').run(r.id, r.projectId, r.name, r.path);
    return r;
  }

  setVerifyCommand(id: string, command: string): void {
    this.db.prepare('UPDATE repos SET verify_command = ? WHERE id = ?').run(command, id);
  }

  isInternal(id: string): boolean {
    return (this.db.prepare('SELECT internal FROM repos WHERE id = ?').get(id) as { internal: number } | undefined)?.internal === 1;
  }

  get(id: string): Repo | undefined {
    const r = this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
    return r && toRepo(r);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  }
}

export type NewWorkspace = Omit<Workspace, 'summary' | 'status' | 'createdAt' | 'engine' | 'role'> & { token: string; engine?: Workspace['engine']; role?: Workspace['role'] };

const PATCH_COLUMNS = { name: 'name', nameLocked: 'name_locked', summary: 'summary', status: 'status', engine: 'engine' } as const;
export type WorkspacePatch = Partial<Pick<Workspace, keyof typeof PATCH_COLUMNS>>;

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  insert(w: NewWorkspace): Workspace {
    this.db.prepare(
      `INSERT INTO workspaces (id, project_id, repo_id, name, name_locked, branch, base_branch, worktree_path,
         agent_kind, permission_mode, token, created_at, engine, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, w.projectId, w.repoId, w.name, w.nameLocked ? 1 : 0, w.branch, w.baseBranch, w.worktreePath,
      // 채팅 방식은 Claude Code 만 된다.
      w.agentKind, w.permissionMode, w.token, Date.now(), w.agentKind === 'claude' ? (w.engine ?? 'chat') : 'terminal', w.role ?? 'worker');
    return this.get(w.id)!;
  }

  /** 프로젝트의 보통 워크스페이스들. 조율 에이전트는 들어 있지 않다 (작업 폴더가 없고, 목록에 보이지 않는다). */
  list(projectId: string): Workspace[] {
    return (this.db.prepare("SELECT * FROM workspaces WHERE project_id = ? AND role = 'worker' ORDER BY created_at, rowid").all(projectId) as WorkspaceRow[]).map(toWorkspace);
  }

  /** 조율 에이전트까지 모두. 이름을 찾거나, 프로젝트의 에이전트를 모두 끌 때 쓴다. */
  listAll(projectId: string): Workspace[] {
    return (this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as WorkspaceRow[]).map(toWorkspace);
  }

  /** 프로젝트의 조율 에이전트. 아직 만들지 않았으면 undefined */
  coordinator(projectId: string): Workspace | undefined {
    const r = this.db.prepare("SELECT * FROM workspaces WHERE project_id = ? AND role = 'coordinator' ORDER BY created_at LIMIT 1").get(projectId) as WorkspaceRow | undefined;
    return r && toWorkspace(r);
  }

  get(id: string): Workspace | undefined {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return r && toWorkspace(r);
  }

  findByToken(token: string): Workspace | undefined {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE token = ?').get(token) as WorkspaceRow | undefined;
    return r && toWorkspace(r);
  }

  getToken(id: string): string {
    const r = this.db.prepare('SELECT token FROM workspaces WHERE id = ?').get(id) as { token: string } | undefined;
    if (!r) throw new Error(`워크스페이스가 없습니다: ${id}`);
    return r.token;
  }

  update(id: string, patch: WorkspacePatch): Workspace {
    for (const key of Object.keys(patch) as (keyof WorkspacePatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      this.db.prepare(`UPDATE workspaces SET ${PATCH_COLUMNS[key]} = ? WHERE id = ?`)
        .run(typeof value === 'boolean' ? (value ? 1 : 0) : value, id);
    }
    const w = this.get(id);
    if (!w) throw new Error(`워크스페이스가 없습니다: ${id}`);
    return w;
  }

  /** 이어갈 대화의 id (채팅 방식). 없으면 undefined */
  getSessionId(id: string): string | undefined {
    const r = this.db.prepare('SELECT session_id FROM workspaces WHERE id = ?').get(id) as { session_id: string | null } | undefined;
    return r?.session_id ?? undefined;
  }

  setSessionId(id: string, sessionId: string | null): void {
    this.db.prepare('UPDATE workspaces SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }
}
