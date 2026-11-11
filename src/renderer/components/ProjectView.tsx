import { useEffect, useState } from 'react';
import type { Project, Repo, RepoStatus, Todo, Workspace } from '@shared/types';
import { groupTodos } from '../todoView';
import { countByRepo, STATUS_LABEL, type Selection } from '../tree';
import { CleanupList, CompleteDialog } from './CleanupPanel';
import { CoordinatorPane } from './CoordinatorPane';
import { ConversationList, type ConversationData } from './ConversationPanel';
import { ConfirmDialog, NewWorkspaceDialog } from './dialogs';
import { Ticks, TodoList } from './TodoPanel';

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

export function ProjectView({ project, repos, workspaces, everyone, todos, conversation, onSelect }: {
  project: Project; repos: Repo[]; workspaces: Workspace[];
  /** 조율 에이전트까지 든 목록 (대화에서 이름을 찾는 데 쓴다) */
  everyone: Workspace[];
  todos: Todo[]; conversation: ConversationData; onSelect: (s: Selection) => void;
}) {
  // 조율: 조율 에이전트와 대화. 현황: 저장소, 워크스페이스, TODO, 정리 대기. 고른 탭은 프로젝트마다 기억한다.
  const tabKey = `dure.projectTab.${project.id}`;
  const [tab, setTab] = useState<'coord' | 'status'>(() => {
    try { const v = window.localStorage.getItem(tabKey); if (v === 'coord' || v === 'status') return v; } catch { /* 기억하지 못해도 된다 */ }
    // 저장소가 없으면 조율 에이전트가 할 수 있는 일이 없다. 현황에서 저장소부터 등록한다.
    return repos.length === 0 ? 'status' : 'coord';
  });
  const switchTab = (next: 'coord' | 'status'): void => { setTab(next); try { window.localStorage.setItem(tabKey, next); } catch { /* 위와 같다 */ } };
  const [statuses, setStatuses] = useState<Record<string, RepoStatus>>({});
  const [error, setError] = useState('');
  const [justAdded, setJustAdded] = useState<Repo | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null); // 저장소 id, '' 이면 고르지 않음
  const [removingProject, setRemovingProject] = useState(false);
  const [completing, setCompleting] = useState(false);
  // 완료된 프로젝트는 기록만 본다.
  const done = project.status === 'done';

  // 등록된 저장소가 지금도 유효한지 확인해 줄마다 보여준다.
  const repoIds = repos.map((r) => r.id).join(',');
  useEffect(() => {
    let alive = true;
    for (const r of repos) {
      window.dure.repos.status(r.id)
        .then((s) => { if (alive) setStatuses((cur) => ({ ...cur, [r.id]: s })); })
        .catch((e: Error) => { if (alive) setStatuses((cur) => ({ ...cur, [r.id]: { ok: false, reason: e.message } })); });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoIds]);

  const counts = countByRepo(workspaces);
  const repoName = (id: string): string => repos.find((r) => r.id === id)?.name ?? '';

  const addRepo = async (): Promise<void> => {
    setError('');
    try {
      const path = await window.dure.repos.pickFolder();
      if (path) setJustAdded(await window.dure.repos.add(project.id, path));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeRepo = async (id: string): Promise<void> => {
    setError('');
    try {
      await window.dure.repos.remove(id);
      if (justAdded?.id === id) setJustAdded(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="project-view">
      <div className="project-head">
        <div>
          <h1>{project.name}{done && <span className="done-badge">완료</span>}</h1>
          <div className="sub">프로젝트 · 저장소 {repos.length}개 · 워크스페이스 {workspaces.length}개</div>
        </div>
        <div className="view-switch" role="tablist" aria-label="프로젝트 화면">
          <button role="tab" aria-selected={tab === 'coord'} className={tab === 'coord' ? 'on' : ''} onClick={() => switchTab('coord')} title="조율 에이전트와 대화합니다. 프로젝트 전체에 일을 시킵니다">조율</button>
          <button role="tab" aria-selected={tab === 'status'} className={tab === 'status' ? 'on' : ''} onClick={() => switchTab('status')} title="저장소, 워크스페이스, TODO, 정리 대기">현황</button>
        </div>
      </div>
      {tab === 'coord' && <CoordinatorPane project={project} repos={repos} everyone={everyone} conversation={conversation} readOnly={done} />}
      {tab === 'status' && (
    <div className="page">
      {done && (
        <div className="done-banner">
          <div>
            <b>완료 처리한 프로젝트입니다.</b> 기록만 볼 수 있습니다.
            {project.completedAt && ` (${new Date(project.completedAt).toLocaleDateString('ko-KR')} 완료)`}
            <div className="muted">다시 열면 워크스페이스를 만들고 에이전트를 시작할 수 있습니다. 완료 처리 때 지운 작업 폴더는 돌아오지 않습니다.</div>
          </div>
          <button className="btn primary" onClick={() => { setError(''); window.dure.projects.reopen(project.id).catch((e: Error) => setError(e.message)); }}>다시 열기</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {justAdded && (
        <div className="notice ok">
          <span className="grow">저장소 <b>{justAdded.name}</b> 을(를) 추가했습니다. 이 저장소로 워크스페이스를 만들까요?</span>
          <button className="btn primary" onClick={() => { setCreatingFor(justAdded.id); setJustAdded(null); }}>만들기</button>
          <button className="btn ghost" onClick={() => setJustAdded(null)}>나중에</button>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>저장소</h2>
          {!done && <button className="btn" onClick={() => void addRepo()}>저장소 추가</button>}
        </div>
        <div className="rows">
          {repos.length === 0 && <div className="rows-empty">등록된 저장소가 없습니다. 로컬 git 저장소 폴더를 추가하세요.</div>}
          {repos.map((r) => {
            const st = statuses[r.id];
            const n = counts[r.id] ?? 0;
            return (
              <div className="row" key={r.id}>
                <div className="grow">
                  <div>{r.name}</div>
                  <div className="path">{r.path}</div>
                  <div className={`repo-status${st && !st.ok ? ' bad' : ''}`}>
                    {!st && '확인하는 중…'}
                    {st?.ok && <>✓ git 저장소 확인됨 · 현재 브랜치 <code>{st.branch}</code></>}
                    {st && !st.ok && <>⚠ {st.reason}</>}
                  </div>
                </div>
                <span className={`tag${n === 0 ? ' warn' : ''}`}>{n === 0 ? '워크스페이스 없음' : `워크스페이스 ${n}개`}</span>
                {!done && <button className={`btn${n === 0 ? ' primary' : ''}`} disabled={st ? !st.ok : false} onClick={() => setCreatingFor(r.id)}>워크스페이스 만들기</button>}
                {!done && <button className="btn ghost" title="목록에서 빼기 (폴더는 그대로)" onClick={() => void removeRepo(r.id)}>빼기</button>}
              </div>
            );
          })}
        </div>
        <div className="help">저장소를 등록하는 것만으로는 에이전트가 일하지 않습니다. 저장소마다 워크스페이스를 만들면 그 저장소의 작업 폴더에서 에이전트가 일합니다. 등록한 저장소는 신뢰하는 것으로 보고, 에이전트가 처음 묻는 “이 폴더를 신뢰하는가” 에 두레가 대신 “신뢰함” 으로 답합니다. 내용을 모르는 저장소는 등록하기 전에 살펴보세요.</div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>워크스페이스</h2>
          {!done && <button className="btn" disabled={repos.length === 0} onClick={() => setCreatingFor('')}>워크스페이스 만들기</button>}
        </div>
        <div className="rows">
          {workspaces.length === 0 && <div className="rows-empty">워크스페이스가 없습니다.</div>}
          {workspaces.map((w) => (
            <div className="row clickable" key={w.id} onClick={() => onSelect({ type: 'workspace', id: w.id, projectId: project.id })}>
              <span className={`dot ${w.status}`} />
              <div className="grow">
                <div>{w.name}</div>
                <div className="path">{repoName(w.repoId)} · {w.branch}</div>
              </div>
              <span className="tag">{AGENT_LABEL[w.agentKind]}</span>
              {w.permissionMode === 'bypass' && <span className="tag warn">승인 생략</span>}
              <span className="tag">{STATUS_LABEL[w.status]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>대화</h2>
          {(conversation.threads.length > 0 || conversation.flow.paused) && (
            <button
              className="btn"
              title={conversation.flow.paused
                ? '메시지 전달을 다시 시작합니다. 멈춤으로 중단된 에이전트는 스스로 이어가지 않습니다: 터미널에서 이어서 하라고 말해 주세요'
                : '모든 에이전트가 하던 일을 멈추고, 메시지 전달도 멈춥니다'}
              onClick={() => { window.dure.messages.pauseProject(project.id, !conversation.flow.paused).catch((e: Error) => setError(e.message)); }}
            >{conversation.flow.paused ? '전체 재개' : '전체 멈춤'}</button>
          )}
        </div>
        {conversation.flow.capped && (
          <div className="thread-notice standalone">
            <span className="grow">이 프로젝트에서 에이전트끼리 50번 주고받아 멈췄습니다. 내용을 확인하고 계속할지 정하세요.</span>
            <button className="btn accent" onClick={() => { window.dure.messages.resume(project.id).catch((e: Error) => setError(e.message)); }}>계속</button>
          </div>
        )}
        <div className="conv-wide">
          <ConversationList
            projectId={project.id}
            threads={conversation.threads}
            data={conversation}
            workspaces={everyone}
            empty="아직 오간 대화가 없습니다. 에이전트가 다른 워크스페이스에 메시지를 보내면 여기에 모두 보입니다."
          />
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>TODO</h2></div>
        <div className="todo-groups">
          {groupTodos(todos, workspaces).map((g) => (
            <div className="todo-group" key={g.key}>
              <div className="todo-group-head">
                {g.workspaceId === null ? <span className="folder" /> : <span className={`dot ${workspaces.find((w) => w.id === g.workspaceId)?.status ?? ''}`} />}
                <span className="t">{g.title}</span>
              </div>
              <Ticks items={g.items} />
              <TodoList projectId={project.id} workspaceId={g.workspaceId} items={g.items} />
            </div>
          ))}
        </div>
        <div className="help">프로젝트 항목은 프로젝트 전체의 할 일입니다. 워크스페이스 항목은 그 워크스페이스의 에이전트가 읽고 씁니다.</div>
      </div>

      <CleanupList project={project} readOnly={done} />

      <div className="section project-end">
        {!done && (
          <div className="end-row">
            <div>
              <div className="end-title">프로젝트 완료 처리</div>
              <div className="muted">일이 끝났으면 완료로 옮깁니다. 지울 것(작업 폴더, 정리 대기)을 목록으로 보고 고릅니다. 기록은 남고 다시 열 수 있습니다.</div>
            </div>
            <button className="btn primary" onClick={() => setCompleting(true)}>완료 처리</button>
          </div>
        )}
        <div className="end-row">
          <div>
            <div className="end-title">완전히 지우기</div>
            <div className="muted">프로젝트와 그 기록(TODO, 대화, 자료)을 두레에서 지웁니다. <b>정리 대기에 옮겨 둔 파일도 영구히 지워집니다.</b> 저장소와 작업 폴더는 지우지 않습니다.</div>
          </div>
          <button className="btn danger" onClick={() => setRemovingProject(true)}>완전히 지우기</button>
        </div>
      </div>
      {completing && <CompleteDialog project={project} onClose={() => setCompleting(false)} onDone={() => setCompleting(false)} />}

      {creatingFor !== null && (
        <NewWorkspaceDialog
          projectId={project.id}
          repos={repos}
          initialRepoId={creatingFor || undefined}
          onClose={() => setCreatingFor(null)}
          onCreated={(ws) => { setCreatingFor(null); onSelect({ type: 'workspace', id: ws.id, projectId: project.id }); }}
        />
      )}
      {removingProject && (
        <ConfirmDialog
          title="프로젝트 완전히 지우기"
          message={`"${project.name}" 프로젝트와 그 워크스페이스 ${workspaces.length}개, TODO·대화·자료 기록, 정리 대기에 옮겨 둔 파일을 두레에서 지웁니다. 실행 중인 에이전트와 터미널은 꺼집니다. 저장소와 작업 폴더는 지우지 않습니다. 되돌릴 수 없습니다.`}
          confirmLabel="지우기"
          onClose={() => setRemovingProject(false)}
          onConfirm={async () => { await window.dure.projects.remove(project.id); setRemovingProject(false); }}
        />
      )}
    </div>
      )}
    </div>
  );
}
