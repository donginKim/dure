import { useCallback, useEffect, useState } from 'react';
import type { Capture } from '@shared/types';
import type { TreeNode } from '../tree';

const ago = (at: number): string => { const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };

/** 받은 메모: 빠른 메모로 적어 둔 것. 프로젝트(또는 워크스페이스)의 TODO 로 보내거나 지운다. 없으면 보이지 않는다. */
export function CaptureInbox({ tree }: { tree: TreeNode[] }) {
  const [list, setList] = useState<Capture[]>([]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.captures.list().then(setList).catch(() => undefined); }, []);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'captures') load(); }); }, [load]);
  if (list.length === 0) return null;
  // 보낼 곳: "프로젝트" 또는 "프로젝트 › 워크스페이스"
  const targets = tree.flatMap((n) => [{ value: `${n.project.id}|`, label: `${n.project.name} (프로젝트 TODO)` }, ...n.workspaces.filter((w) => w.role !== 'coordinator').map((w) => ({ value: `${n.project.id}|${w.id}`, label: `${n.project.name} › ${w.name}` }))]);
  const chosen = target || targets[0]?.value || '';
  const send = (id: string): void => {
    const [projectId, workspaceId] = chosen.split('|');
    if (!projectId) return;
    setError('');
    window.dure.captures.toTodo(id, projectId, workspaceId || null).catch((e: Error) => setError(e.message));
  };
  return (
    <div className="inbox">
      <div className="inbox-head">
        <b>받은 메모 <span className="count">{list.length}</span></b>
        <span className="grow" />
        {targets.length > 0 && <select value={chosen} title="TODO 로 보낼 곳" onChange={(e) => setTarget(e.target.value)}>{targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>}
      </div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      {list.slice(0, 8).map((c) => (
        <div key={c.id} className="inbox-row">
          <div className="grow inbox-text" title={c.text}>{c.text}</div>
          <span className="muted">{ago(c.createdAt)}</span>
          <button className="btn" disabled={!chosen} onClick={() => send(c.id)}>TODO 로</button>
          <button className="btn ghost" onClick={() => { window.dure.captures.remove(c.id).catch(() => undefined); }}>지우기</button>
        </div>
      ))}
      {list.length > 8 && <div className="muted">외 {list.length - 8}개</div>}
    </div>
  );
}
