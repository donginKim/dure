import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Repo, RepoStatus } from '@shared/types';
import { openDatabase } from './db';
import { createGit, type Git } from './git';
import { startMcpServer } from './mcp/server';
import { workspaceTools } from './mcp/tools/workspace';
import { PtyManager } from './pty';
import { ProjectStore, RepoStore, WorkspaceStore } from './stores';
import { WorkspaceService } from './workspaceService';

export interface Core {
  projects: ProjectStore;
  repos: RepoStore;
  workspaces: WorkspaceStore;
  service: WorkspaceService;
  pty: PtyManager;
  git: Git;
  mcpUrl: string;
  addRepo(projectId: string, path: string): Promise<Repo>;
  repoStatus(repoId: string): Promise<RepoStatus>;
  dispose(): Promise<void>;
}

export interface CoreOptions {
  /** SQLite 파일과 워크스페이스별 설정 파일을 두는 폴더 */
  dataDir: string;
  /** worktree 를 만드는 상위 폴더 */
  worktreeRoot: string;
  /** 터미널과 에이전트에 물려줄 환경 (로그인 셸 환경) */
  baseEnv: Record<string, string>;
}

/** 두레 코어를 만든다. 모든 상태의 원본이다. Electron 에 의존하지 않는다. */
export async function createCore(o: CoreOptions): Promise<Core> {
  mkdirSync(o.dataDir, { recursive: true });
  const db = openDatabase(join(o.dataDir, 'dure.db'));
  const projects = new ProjectStore(db);
  const repos = new RepoStore(db);
  const workspaces = new WorkspaceStore(db);

  // 지난 실행에서 살아 있던 터미널은 이제 없다. 남은 상태를 되돌린다.
  for (const p of projects.list()) {
    for (const w of workspaces.list(p.id)) {
      if (w.status !== 'stopped') workspaces.update(w.id, { status: 'stopped' });
    }
  }

  const pty = new PtyManager();
  const git = createGit(o.baseEnv);
  const mcp = await startMcpServer({ workspaces, projects, repos }, [workspaceTools]);
  const service = new WorkspaceService({
    projects, repos, workspaces, pty, git, mcpUrl: mcp.url, dataDir: o.dataDir, worktreeRoot: o.worktreeRoot, baseEnv: o.baseEnv,
  });

  let disposed = false;
  return {
    projects, repos, workspaces, service, pty, git, mcpUrl: mcp.url,
    async addRepo(projectId, path) {
      if (!projects.get(projectId)) throw new Error(`프로젝트가 없습니다: ${projectId}`);
      if (!(await git.isGitRepo(path))) throw new Error(`git 저장소가 아닙니다: ${path}`);
      return repos.add(projectId, path);
    },
    async repoStatus(repoId) {
      const repo = repos.get(repoId);
      if (!repo) throw new Error(`저장소가 없습니다: ${repoId}`);
      if (!existsSync(repo.path)) return { ok: false, reason: '폴더를 찾을 수 없습니다.' };
      if (!(await git.isGitRepo(repo.path))) return { ok: false, reason: 'git 저장소가 아닙니다.' };
      return { ok: true, branch: await git.currentBranch(repo.path) };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      service.detach();
      await pty.killAll();
      await mcp.close();
      db.close();
    },
  };
}
