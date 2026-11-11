import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, Repo, Workspace } from '@shared/types';
import { ProjectsHome } from './components/ProjectsHome';
import { ProjectView } from './components/ProjectView';
import { Sidebar } from './components/Sidebar';
import { WorkspaceView } from './components/WorkspaceView';
import { buildTree, reconcileSelection, type Selection } from './tree';

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const ps = await window.dure.projects.list();
      const [ws, rs] = await Promise.all([
        Promise.all(ps.map((p) => window.dure.workspaces.list(p.id))),
        Promise.all(ps.map((p) => window.dure.repos.list(p.id))),
      ]);
      setProjects(ps);
      setWorkspaces(ws.flat());
      setRepos(rs.flat());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    return window.dure.onChanged((topic) => {
      if (topic !== 'terminals') void reload();
    });
  }, [reload]);

  const tree = useMemo(() => buildTree(projects, workspaces), [projects, workspaces]);
  const current = useMemo(() => reconcileSelection(selection, tree), [selection, tree]);

  const createProject = async (name: string): Promise<void> => {
    const p = await window.dure.projects.create(name);
    await reload();
    setSelection({ type: 'project', id: p.id });
  };

  const node = current?.type === 'project' ? tree.find((n) => n.project.id === current.id) : undefined;
  const workspace = current?.type === 'workspace' ? workspaces.find((w) => w.id === current.id) : undefined;

  return (
    <div className="app">
      <Sidebar tree={tree} repos={repos} selection={current} onSelect={setSelection} onCreateProject={createProject} />
      <main className="main">
        {error && <div className="error" style={{ margin: 12 }}>{error}</div>}
        {node && (
          <ProjectView
            key={node.project.id}
            project={node.project}
            repos={repos.filter((r) => r.projectId === node.project.id)}
            workspaces={node.workspaces}
            onSelect={setSelection}
          />
        )}
        {workspace && (
          <WorkspaceView
            key={workspace.id}
            workspace={workspace}
            project={projects.find((p) => p.id === workspace.projectId)}
            repo={repos.find((r) => r.id === workspace.repoId)}
            onSelect={setSelection}
          />
        )}
        {!node && !workspace && <ProjectsHome tree={tree} repos={repos} onSelect={setSelection} />}
      </main>
    </div>
  );
}
