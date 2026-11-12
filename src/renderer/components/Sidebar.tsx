import { useState, type ReactNode } from 'react';
import type { Project, Repo, Todo, Workspace } from '@shared/types';
import { deliveryNote } from '../conversationView';
import { progress } from '../todoView';
import type { ConversationData } from './ConversationPanel';
import { STATUS_LABEL, type Selection, type TreeNode } from '../tree';

export function Sidebar({ tree, repos, todos, talk, selection, onSelect, onCreateProject, dbWaiting, browserWaiting, peerWaiting, peopleAlert = 0 }: {
  /** 다른 사람의 메시지가 넘겨주기를 기다리는 워크스페이스 */
  peerWaiting?: Set<string>;
  /** 받은 연결 요청과 초대의 수 */
  peopleAlert?: number;
  /** DB 조회 승인을 기다리는 워크스페이스 */
  dbWaiting?: Set<string>;
  /** 브라우저 주소 허용을 기다리는 워크스페이스 */
  browserWaiting?: Set<string>;
  tree: TreeNode[]; repos: Repo[]; todos: Todo[]; talk: Record<string, ConversationData>; selection: Selection; onSelect: (s: Selection) => void; onCreateProject: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showDone, setShowDone] = useState(false);
  const repoName = (id: string): string => repos.find((r) => r.id === id)?.name ?? '';
  const progressOf = (workspaceId: string): string => {
    const { done, total } = progress(todos.filter((t) => t.workspaceId === workspaceId));
    return total > 0 ? `${done}/${total}` : '';
  };

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    try {
      await onCreateProject(name);
      setName('');
      setAdding(false);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 진행 중인 프로젝트와 완료 처리한 프로젝트를 나눠 보인다. 완료는 접혀 있다.
  const active = tree.filter((n) => n.project.status !== 'done');
  const done = tree.filter((n) => n.project.status === 'done');
  const renderProject = (project: Project, workspaces: Workspace[]): ReactNode => {
          const closed = collapsed[project.id] === true;
          return (
            <div key={project.id} className="tree-group">
              <div
                className={`tree-project${selection?.type === 'project' && selection.id === project.id ? ' selected' : ''}${project.status === 'done' ? ' done' : ''}`}
                title="프로젝트 화면 열기: 저장소와 워크스페이스 관리"
                onClick={() => onSelect({ type: 'project', id: project.id })}
              >
                <span
                  className="chev"
                  title={closed ? '펼치기' : '접기'}
                  onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [project.id]: !closed })); }}
                >{closed ? '▸' : '▾'}</span>
                <span className="folder" />
                <span className="pname">{project.name}</span>
                {(talk[project.id]?.flow.paused || talk[project.id]?.flow.capped) && (
                  <span className="flag" title={talk[project.id]?.flow.capped ? '에이전트끼리 너무 많이 주고받아 멈췄습니다' : '프로젝트 전체가 멈춰 있습니다'}>멈춤</span>
                )}
                <span className="count" title="워크스페이스 수">{workspaces.length}</span>
              </div>
              {!closed && workspaces.length === 0 && <div className="tree-empty">워크스페이스 없음 · 프로젝트를 눌러 만드세요</div>}
              {!closed && workspaces.map((w) => (
                <div
                  key={w.id}
                  className={`tree-ws${selection?.type === 'workspace' && selection.id === w.id ? ' selected' : ''}`}
                  title={`저장소 ${repoName(w.repoId)} · ${w.branch} · ${STATUS_LABEL[w.status]}`}
                  onClick={() => onSelect({ type: 'workspace', id: w.id, projectId: project.id })}
                >
                  <span className={`dot ${w.status}`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="ws-name">{w.name}{progressOf(w.id) && <span className="ws-progress" title="TODO 진행도">{progressOf(w.id)}</span>}</div>
                    <div className="ws-meta">{repoName(w.repoId)} · {w.summary || STATUS_LABEL[w.status]}</div>
                    {dbWaiting?.has(w.id) && <div className="ws-wait" title="에이전트가 DB 조회 승인을 기다립니다. 워크스페이스를 열어 허용하거나 거부하세요">DB 조회 승인 대기</div>}
                    {browserWaiting?.has(w.id) && <div className="ws-wait" title="에이전트가 브라우저로 주소를 열어도 되는지 묻고 있습니다. 워크스페이스를 열어 허용하거나 거부하세요">브라우저 주소 허용 대기</div>}
                    {peerWaiting?.has(w.id) && <div className="ws-wait" title="다른 사람의 에이전트가 보낸 메시지가 있습니다. 워크스페이스를 열어 넘겨주거나 버리세요">다른 사람의 메시지 확인 대기</div>}
                    {(() => {
                      const info = talk[project.id]?.delivery[w.id];
                      if (!info || (info.waiting === 0 && info.held === 0)) return null;
                      const note = deliveryNote(info);
                      return note.attention
                        ? <div className="ws-wait" title={note.text}>메시지 {info.waiting + info.held}건 전달 대기</div>
                        : null;
                    })()}
                  </div>
                </div>
              ))}
            </div>
          );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="brand" title="프로젝트 전체 보기" onClick={() => onSelect(null)}>두레<small>dure</small></button>
      </div>
      <div className="side-section">
        <button className={`side-title${selection === null ? ' selected' : ''}`} title="프로젝트 전체 보기" onClick={() => onSelect(null)}>
          진행 중 <span className="count">{active.length}</span>
        </button>
        <button className="btn ghost" title="새 프로젝트 만들기" onClick={() => setAdding((v) => !v)}>+ 새 프로젝트</button>
      </div>
      {adding && (
        <form className="new-project" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input type="text" autoFocus value={name} placeholder="프로젝트 이름 (예: 쇼핑몰)" onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!name.trim()}>만들기</button>
        </form>
      )}
      {error && <div className="error" style={{ margin: '0 10px 8px' }}>{error}</div>}
      <div className="tree">
        {active.length === 0 && <div className="tree-empty" style={{ paddingLeft: 10 }}>{done.length ? '진행 중인 프로젝트가 없습니다.' : '프로젝트가 없습니다. 위의 "+ 새 프로젝트"로 만드세요.'}</div>}
        {active.map(({ project, workspaces }) => renderProject(project, workspaces))}
        {done.length > 0 && (
          <>
            <button className="tree-done-head" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} title="완료 처리한 프로젝트. 기록을 볼 수 있고 다시 열 수 있습니다">
              <span className="chev">{showDone ? '▾' : '▸'}</span>완료 <span className="count">{done.length}</span>
            </button>
            {showDone && done.map(({ project, workspaces }) => renderProject(project, workspaces))}
          </>
        )}
      </div>
      <button className={`side-settings side-people${selection?.type === 'people' ? ' selected' : ''}`} title="두레를 쓰는 다른 사람과 연결합니다" onClick={() => onSelect({ type: 'people' })}>
        <span className="gear" aria-hidden>◎</span>사람{peopleAlert > 0 && <span className="pip" title="확인할 요청이나 초대가 있습니다" />}
      </button>
      <button className={`side-settings${selection?.type === 'settings' ? ' selected' : ''}`} onClick={() => onSelect({ type: 'settings' })}>
        <span className="gear" aria-hidden>⚙</span>설정
      </button>
    </aside>
  );
}
