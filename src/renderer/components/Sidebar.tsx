import { useState } from 'react';
import { STATUS_LABEL, type Selection, type TreeNode } from '../tree';

export function Sidebar({ tree, selection, onSelect, onCreateProject }: {
  tree: TreeNode[]; selection: Selection; onSelect: (s: Selection) => void; onCreateProject: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    try {
      await onCreateProject(name);
      setName('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">두레<small>dure</small></div>
      </div>
      <div className="tree">
        {tree.length === 0 && <div className="tree-empty" style={{ paddingLeft: 8 }}>프로젝트가 없습니다. 아래에서 만드세요.</div>}
        {tree.map(({ project, workspaces }) => (
          <div key={project.id}>
            <div
              className={`tree-project${selection?.type === 'project' && selection.id === project.id ? ' selected' : ''}`}
              onClick={() => onSelect({ type: 'project', id: project.id })}
            >
              {project.name}
            </div>
            {workspaces.length === 0 && <div className="tree-empty">워크스페이스 없음</div>}
            {workspaces.map((w) => (
              <div
                key={w.id}
                className={`tree-ws${selection?.type === 'workspace' && selection.id === w.id ? ' selected' : ''}`}
                title={`${STATUS_LABEL[w.status]} · ${w.branch}`}
                onClick={() => onSelect({ type: 'workspace', id: w.id, projectId: project.id })}
              >
                <span className={`dot ${w.status}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="ws-name">{w.name}</div>
                  <div className="ws-meta">{w.summary || STATUS_LABEL[w.status]}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {error && <div className="error" style={{ margin: '0 10px 8px' }}>{error}</div>}
      <form className="new-project" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input type="text" value={name} placeholder="새 프로젝트 이름" onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>추가</button>
      </form>
    </aside>
  );
}
