import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import type { Project, Repo, Workspace } from '@shared/types';

interface ProjectRow { id: string; name: string; created_at: number }
interface RepoRow { id: string; project_id: string; name: string; path: string }
interface WorkspaceRow {
  id: string; project_id: string; repo_id: string; name: string; name_locked: number; summary: string;
  branch: string; base_branch: string; worktree_path: string; agent_kind: string; permission_mode: string;
  status: string; token: string; created_at: number;
}

const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, createdAt: r.created_at });
const toRepo = (r: RepoRow): Repo => ({ id: r.id, projectId: r.project_id, name: r.name, path: r.path });
// 토큰은 일부러 옮기지 않는다. 화면으로 나가는 객체에 들어가면 안 된다.
const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id, projectId: r.project_id, repoId: r.repo_id, name: r.name, nameLocked: r.name_locked === 1,
  summary: r.summary, branch: r.branch, baseBranch: r.base_branch, worktreePath: r.worktree_path,
  agentKind: r.agent_kind as Workspace['agentKind'], permissionMode: r.permission_mode as Workspace['permissionMode'],
  status: r.status as Workspace['status'], createdAt: r.created_at,
});

export class ProjectStore {
  constructor(private readonly db: Database.Database) {}

  create(name: string): Project {
    const p: Project = { id: crypto.randomUUID(), name, createdAt: Date.now() };
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
    const r: Repo = { id: crypto.randomUUID(), projectId, name: basename(path), path };
    this.db.prepare('INSERT INTO repos (id, project_id, name, path) VALUES (?, ?, ?, ?)').run(r.id, r.projectId, r.name, r.path);
    return r;
  }

  list(projectId: string): Repo[] {
    return (this.db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY rowid').all(projectId) as RepoRow[]).map(toRepo);
  }

  get(id: string): Repo | undefined {
    const r = this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
    return r && toRepo(r);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  }
}

export type NewWorkspace = Omit<Workspace, 'summary' | 'status' | 'createdAt'> & { token: string };

const PATCH_COLUMNS = { name: 'name', nameLocked: 'name_locked', summary: 'summary', status: 'status' } as const;
export type WorkspacePatch = Partial<Pick<Workspace, keyof typeof PATCH_COLUMNS>>;

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  insert(w: NewWorkspace): Workspace {
    this.db.prepare(
      `INSERT INTO workspaces (id, project_id, repo_id, name, name_locked, branch, base_branch, worktree_path,
         agent_kind, permission_mode, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, w.projectId, w.repoId, w.name, w.nameLocked ? 1 : 0, w.branch, w.baseBranch, w.worktreePath,
      w.agentKind, w.permissionMode, w.token, Date.now());
    return this.get(w.id)!;
  }

  list(projectId: string): Workspace[] {
    return (this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as WorkspaceRow[]).map(toWorkspace);
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

  remove(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }
}
