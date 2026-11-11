import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeliveryInfo } from '@shared/ipc';
import type { Artifact, Message, Project, ProjectFlow, Repo, Thread, Todo, Workspace } from '@shared/types';
import type { ConversationData } from './components/ConversationPanel';
import type { PendingInfo } from './components/TodoPanel';
import { ProjectsHome } from './components/ProjectsHome';
import { ProjectView } from './components/ProjectView';
import { Sidebar } from './components/Sidebar';
import { WorkspaceView } from './components/WorkspaceView';
import { buildTree, reconcileSelection, type Selection } from './tree';

const EMPTY_FLOW: ProjectFlow = { paused: false, capped: false, agentStreak: 0 };
const EMPTY_TALK: ConversationData = {
  threads: [] as Thread[], messages: {}, artifacts: [] as Artifact[], flow: EMPTY_FLOW, delivery: {} as Record<string, DeliveryInfo>,
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [pending, setPending] = useState<Record<string, PendingInfo>>({});
  // 프로젝트 id → 그 프로젝트의 대화
  const [talk, setTalk] = useState<Record<string, ConversationData>>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const ps = await window.dure.projects.list();
      const [ws, rs, ts, pe] = await Promise.all([
        Promise.all(ps.map((p) => window.dure.workspaces.list(p.id))),
        Promise.all(ps.map((p) => window.dure.repos.list(p.id))),
        Promise.all(ps.map((p) => window.dure.todos.list(p.id))),
        Promise.all(ps.map((p) => window.dure.todos.pending(p.id))),
      ]);
      setProjects(ps);
      setWorkspaces(ws.flat());
      setRepos(rs.flat());
      setTodos(ts.flat());
      setPending(Object.assign({}, ...pe));
      const talks = await Promise.all(ps.map(async (p): Promise<[string, ConversationData]> => {
        const [threads, artifacts, flow, delivery] = await Promise.all([
          window.dure.messages.threads(p.id), window.dure.artifacts.list(p.id), window.dure.messages.flow(p.id), window.dure.messages.delivery(p.id),
        ]);
        const lists = await Promise.all(threads.map((t) => window.dure.messages.list(t.id)));
        const messages: Record<string, Message[]> = {};
        threads.forEach((t, i) => { messages[t.id] = lists[i]; });
        return [p.id, { threads, messages, artifacts, flow, delivery }];
      }));
      setTalk(Object.fromEntries(talks));
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
      <Sidebar tree={tree} repos={repos} todos={todos} talk={talk} selection={current} onSelect={setSelection} onCreateProject={createProject} />
      <main className="main">
        {error && <div className="error" style={{ margin: 12 }}>{error}</div>}
        {node && (
          <ProjectView
            key={node.project.id}
            project={node.project}
            repos={repos.filter((r) => r.projectId === node.project.id)}
            workspaces={node.workspaces}
            todos={todos.filter((t) => t.projectId === node.project.id)}
            conversation={talk[node.project.id] ?? EMPTY_TALK}
            onSelect={setSelection}
          />
        )}
        {workspace && (
          <WorkspaceView
            key={workspace.id}
            workspace={workspace}
            workspaces={workspaces.filter((w) => w.projectId === workspace.projectId)}
            conversation={talk[workspace.projectId] ?? EMPTY_TALK}
            project={projects.find((p) => p.id === workspace.projectId)}
            repo={repos.find((r) => r.id === workspace.repoId)}
            todos={todos.filter((t) => t.workspaceId === workspace.id)}
            pending={pending[workspace.id]}
            onSelect={setSelection}
          />
        )}
        {!node && !workspace && <ProjectsHome tree={tree} repos={repos} onSelect={setSelection} />}
      </main>
    </div>
  );
}
