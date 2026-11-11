import type { Repo } from '@shared/types';
import { STATUS_LABEL, type Selection, type TreeNode } from '../tree';

/** 아무것도 고르지 않았을 때 보이는 화면: 운영 중인 프로젝트 전체. */
export function ProjectsHome({ tree, repos, onSelect }: { tree: TreeNode[]; repos: Repo[]; onSelect: (s: Selection) => void }) {
  return (
    <div className="page">
      <h1>프로젝트</h1>
      <div className="sub">
        프로젝트는 함께 움직이는 저장소와 워크스페이스의 묶음입니다. 보통 프론트와 백엔드 한 세트가 한 프로젝트입니다.
      </div>
      {tree.length === 0 && (
        <div className="rows"><div className="rows-empty">아직 프로젝트가 없습니다. 왼쪽 위의 "+ 새 프로젝트"로 만드세요.</div></div>
      )}
      <div className="cards-grid">
        {tree.map(({ project, workspaces }) => {
          const projectRepos = repos.filter((r) => r.projectId === project.id);
          const running = workspaces.filter((w) => w.status !== 'stopped').length;
          return (
            <div className="pcard" key={project.id} onClick={() => onSelect({ type: 'project', id: project.id })}>
              <div className="pcard-title"><span className="folder" />{project.name}</div>
              <div className="pcard-meta">저장소 {projectRepos.length}개 · 워크스페이스 {workspaces.length}개{running > 0 ? ` · 실행 중 ${running}개` : ''}</div>
              <div className="pcard-list">
                {projectRepos.length === 0 && <div className="muted">저장소를 추가하세요</div>}
                {workspaces.slice(0, 4).map((w) => (
                  <div
                    className="pcard-ws"
                    key={w.id}
                    onClick={(e) => { e.stopPropagation(); onSelect({ type: 'workspace', id: w.id, projectId: project.id }); }}
                  >
                    <span className={`dot ${w.status}`} />
                    <span className="grow">{w.name}</span>
                    <span className="muted">{STATUS_LABEL[w.status]}</span>
                  </div>
                ))}
                {workspaces.length > 4 && <div className="muted">외 {workspaces.length - 4}개</div>}
                {projectRepos.length > 0 && workspaces.length === 0 && <div className="muted">워크스페이스 없음</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
