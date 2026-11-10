import { useCallback, useEffect, useState } from 'react';
import type { Project, Repo, Workspace } from '@shared/types';
import { STATUS_LABEL, type Selection } from '../tree';
import { ConfirmDialog, NewWorkspaceDialog } from './dialogs';

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

export function ProjectView({ project, workspaces, onSelect }: {
  project: Project; workspaces: Workspace[]; onSelect: (s: Selection) => void;
}) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [removingProject, setRemovingProject] = useState(false);

  const loadRepos = useCallback(() => {
    window.dure.repos.list(project.id).then(setRepos).catch((e: Error) => setError(e.message));
  }, [project.id]);

  useEffect(() => {
    setError('');
    loadRepos();
    return window.dure.onChanged((topic) => { if (topic === 'repos') loadRepos(); });
  }, [loadRepos]);

  const addRepo = async (): Promise<void> => {
    setError('');
    try {
      const path = await window.dure.repos.pickFolder();
      if (path) await window.dure.repos.add(project.id, path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeRepo = async (id: string): Promise<void> => {
    setError('');
    try {
      await window.dure.repos.remove(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <h1>{project.name}</h1>
      <div className="sub">프로젝트 · 함께 움직이는 워크스페이스의 묶음</div>
      {error && <div className="error">{error}</div>}

      <div className="section">
        <div className="section-head">
          <h2>저장소</h2>
          <button className="btn" onClick={() => void addRepo()}>저장소 추가</button>
        </div>
        <div className="rows">
          {repos.length === 0 && <div className="rows-empty">등록된 저장소가 없습니다. 로컬 git 저장소 폴더를 추가하세요.</div>}
          {repos.map((r) => (
            <div className="row" key={r.id}>
              <div className="grow">
                <div>{r.name}</div>
                <div className="path">{r.path}</div>
              </div>
              <button className="btn ghost" title="목록에서 빼기 (폴더는 그대로)" onClick={() => void removeRepo(r.id)}>빼기</button>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>워크스페이스</h2>
          <button className="btn primary" disabled={repos.length === 0} onClick={() => setCreating(true)}>워크스페이스 만들기</button>
        </div>
        <div className="rows">
          {workspaces.length === 0 && <div className="rows-empty">워크스페이스가 없습니다.</div>}
          {workspaces.map((w) => (
            <div className="row clickable" key={w.id} onClick={() => onSelect({ type: 'workspace', id: w.id, projectId: project.id })}>
              <span className={`dot ${w.status}`} />
              <div className="grow">
                <div>{w.name}</div>
                <div className="path">{w.branch}</div>
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

      {creating && (
        <NewWorkspaceDialog
          projectId={project.id}
          repos={repos}
          onClose={() => setCreating(false)}
          onCreated={(ws) => { setCreating(false); onSelect({ type: 'workspace', id: ws.id, projectId: project.id }); }}
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
