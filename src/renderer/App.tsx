import { useCallback, useEffect, useMemo, useState } from 'react';
import { PeopleView } from './components/PeopleView';
import { setRemoteNames } from './peersView';
import { BrowserHost } from './components/BrowserHost';
import type { DeliveryInfo } from '@shared/ipc';
import type { Artifact, Message, Project, ProjectFlow, Repo, Thread, Todo, Workspace } from '@shared/types';
import type { ConversationData } from './components/ConversationPanel';
import type { PendingInfo } from './components/TodoPanel';
import { ProjectsHome } from './components/ProjectsHome';
import { ProjectView } from './components/ProjectView';
import { SettingsView } from './components/SettingsView';
import { AttentionView } from './components/AttentionView';
import { WorkTimeView } from './components/WorkTimeView';
import { WorkBadge } from './components/WorkBadge';
import { attentionTarget } from './attentionView';
import { NotesPanel } from './components/NotesPanel';
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
  // DB 조회 승인을 기다리는 워크스페이스. 에이전트는 '작업 중' 으로 보이지만 실제로는 사용자를 기다린다.
  const [dbWaiting, setDbWaiting] = useState<Set<string>>(new Set());
  const [browserWaiting, setBrowserWaiting] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [peerWaiting, setPeerWaiting] = useState<Set<string>>(new Set());
  const [peopleAlert, setPeopleAlert] = useState(0);
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
      setLoaded(true);
      setRepos(rs.flat());
      setTodos(ts.flat());
      setPending(Object.assign({}, ...pe));
      const reqs = await Promise.all(ps.map((p) => window.dure.db.requests(p.id).catch(() => [])));
      const opens = await Promise.all(ps.map((p) => window.dure.browser.requests(p.id).catch(() => [])));
      setDbWaiting(new Set(reqs.flat().map((r) => r.workspaceId)));
      setBrowserWaiting(new Set(opens.flat().map((r) => r.workspaceId)));
      // 다른 사람의 두레: 이름표, 넘겨주기를 기다리는 메시지, 받은 요청과 초대
      const [names, held, reqs2, invs] = await Promise.all([
        window.dure.peers.names().catch(() => ({})), Promise.all(ps.map((p) => window.dure.peers.held(p.id).catch(() => []))),
        window.dure.peers.requests().catch(() => []), window.dure.peers.invites().catch(() => []),
      ]);
      setRemoteNames(names);
      setPeerWaiting(new Set(held.flat().map((h) => h.toWorkspaceId)));
      setPeopleAlert(reqs2.filter((r) => r.direction === 'in').length + invs.length);
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

  // 글자 크기 설정을 화면 전체의 값으로 둔다. 터미널은 열릴 때 이 값을 읽는다.
  useEffect(() => {
    const apply = (): void => {
      window.dure.settings.get().then((s) => {
        document.documentElement.style.setProperty('--chat-font', `${s.chatFontSize}px`);
        document.documentElement.style.setProperty('--term-font', String(s.terminalFontSize));
      }).catch(() => undefined);
    };
    apply();
    return window.dure.onChanged((topic) => { if (topic === 'settings') apply(); });
  }, []);

  useEffect(() => {
    void reload();
    return window.dure.onChanged((topic) => {
      // 채팅 보기의 변화는 그 화면이 스스로 다시 읽는다. 여기서 전부 다시 읽으면 에이전트가 일하는 내내 목록을 다시 받는다.
      if (topic !== 'terminals' && topic !== 'chat' && topic !== 'settings' && topic !== 'cleanup') void reload();
    });
  }, [reload]);

  const tree = useMemo(() => buildTree(projects, workspaces), [projects, workspaces]);
  const current = useMemo(() => reconcileSelection(selection, tree), [selection, tree]);

  // 확인할 것의 수 (사이드바에 보인다). 알림을 누르면 그 항목이 있는 화면을 연다.
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    const load = (): void => { window.dure.attention.list().then((l) => setAttention(l.length)).catch(() => undefined); };
    load();
    return window.dure.onChanged((topic) => { if (topic === 'attention') load(); });
  }, []);
  const coordinatorIds = useMemo(() => new Set(workspaces.filter((w) => w.role === 'coordinator').map((w) => w.id)), [workspaces]);
  useEffect(() => window.dure.attention.onOpen((item) => setSelection(attentionTarget(item, coordinatorIds))), [coordinatorIds]);

  // 메모장: 어느 화면에서든 오른쪽에 열어 쓴다 (⌘⇧M).
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyM') { e.preventDefault(); setNotesOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const createProject = async (name: string): Promise<void> => {
    const p = await window.dure.projects.create(name);
    await reload();
    setSelection({ type: 'project', id: p.id });
  };

  const node = current?.type === 'project' ? tree.find((n) => n.project.id === current.id) : undefined;
  const workspace = current?.type === 'workspace' ? workspaces.find((w) => w.id === current.id) : undefined;

  return (
    <div className="app">
      <Sidebar tree={tree} repos={repos} todos={todos} talk={talk} dbWaiting={dbWaiting} browserWaiting={browserWaiting} peerWaiting={peerWaiting} peopleAlert={peopleAlert} selection={current} onSelect={setSelection} onCreateProject={createProject} notesOpen={notesOpen} onToggleNotes={() => setNotesOpen((v) => !v)} attention={attention} />
      <BrowserHost workspaces={workspaces} loaded={loaded} />
      <main className="main">
        {error && <div className="error" style={{ margin: 12 }}>{error}</div>}
        {node && (
          <ProjectView
            key={node.project.id}
            project={node.project}
            repos={repos.filter((r) => r.projectId === node.project.id)}
            workspaces={node.workspaces}
            everyone={workspaces.filter((w) => w.projectId === node.project.id)}
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
            projectTodos={todos.filter((t) => t.projectId === workspace.projectId)}
            pending={pending[workspace.id]}
            readOnly={projects.find((p) => p.id === workspace.projectId)?.status === 'done'}
            onSelect={setSelection}
          />
        )}
        {current?.type === 'settings' && <SettingsView />}
        {current?.type === 'attention' && <AttentionView workspaces={workspaces} onSelect={setSelection} />}
        {current?.type === 'worktime' && <WorkTimeView onOpenSettings={() => setSelection({ type: 'settings' })} />}
        {current?.type === 'people' && <PeopleView projects={projects} onOpenSettings={() => setSelection({ type: 'settings' })} />}
        {!node && !workspace && current?.type !== 'settings' && current?.type !== 'people' && current?.type !== 'attention' && current?.type !== 'worktime' && <ProjectsHome tree={tree.filter((n) => n.project.status !== 'done')} repos={repos} onSelect={setSelection} />}
      </main>
      {notesOpen && <NotesPanel onClose={() => setNotesOpen(false)} />}
      {!notesOpen && current?.type !== 'worktime' && <WorkBadge onOpen={() => setSelection({ type: 'worktime' })} />}
    </div>
  );
}
