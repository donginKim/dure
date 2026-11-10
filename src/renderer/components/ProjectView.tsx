import { useEffect, useState } from 'react';
import type { Project, Repo, RepoStatus, Workspace } from '@shared/types';
import { countByRepo, STATUS_LABEL, type Selection } from '../tree';
import { ConfirmDialog, NewWorkspaceDialog } from './dialogs';

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

export function ProjectView({ project, repos, workspaces, onSelect }: {
  project: Project; repos: Repo[]; workspaces: Workspace[]; onSelect: (s: Selection) => void;
}) {
  const [statuses, setStatuses] = useState<Record<string, RepoStatus>>({});
  const [error, setError] = useState('');
  const [justAdded, setJustAdded] = useState<Repo | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null); // 저장소 id, '' 이면 고르지 않음
  const [removingProject, setRemovingProject] = useState(false);

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
    <div className="page">
      <h1>{project.name}</h1>
      <div className="sub">프로젝트 · 저장소 {repos.length}개 · 워크스페이스 {workspaces.length}개</div>
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
          <button className="btn" onClick={() => void addRepo()}>저장소 추가</button>
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
                <button className={`btn${n === 0 ? ' primary' : ''}`} disabled={st ? !st.ok : false} onClick={() => setCreatingFor(r.id)}>워크스페이스 만들기</button>
                <button className="btn ghost" title="목록에서 빼기 (폴더는 그대로)" onClick={() => void removeRepo(r.id)}>빼기</button>
              </div>
            );
          })}
        </div>
        <div className="help">저장소를 등록하는 것만으로는 에이전트가 일하지 않습니다. 저장소마다 워크스페이스를 만들면 그 저장소의 작업 폴더에서 에이전트가 일합니다.</div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>워크스페이스</h2>
          <button className="btn" disabled={repos.length === 0} onClick={() => setCreatingFor('')}>워크스페이스 만들기</button>
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
        <button className="btn danger" onClick={() => setRemovingProject(true)}>프로젝트 지우기</button>
      </div>

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
          title="프로젝트 지우기"
          message={`"${project.name}" 프로젝트와 그 워크스페이스 ${workspaces.length}개를 두레에서 지웁니다. 실행 중인 터미널은 꺼집니다. 저장소와 작업 폴더는 지우지 않습니다.`}
          confirmLabel="지우기"
          onClose={() => setRemovingProject(false)}
          onConfirm={async () => { await window.dure.projects.remove(project.id); setRemovingProject(false); }}
        />
      )}
    </div>
  );
}
