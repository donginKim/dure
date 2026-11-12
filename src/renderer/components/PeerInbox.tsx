import { useCallback, useEffect, useState } from 'react';
import type { HeldMessage, Workspace } from '@shared/types';

/**
 * 다른 사람의 에이전트가 보낸 메시지 가운데, 내가 보고 넘겨주기를 기다리는 것.
 * 넘겨줘야 내 에이전트에게 간다. 버리면 가지 않는다.
 */
export function PeerInbox({ projectId, workspaceId, workspaces }: { projectId: string; workspaceId?: string; workspaces: Workspace[] }) {
  const [held, setHeld] = useState<HeldMessage[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.peers.held(projectId).then(setHeld).catch(() => undefined); }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'peers') load(); });
  }, [load]);
  const shown = workspaceId ? held.filter((h) => h.toWorkspaceId === workspaceId) : held;
  if (shown.length === 0) return error ? <div className="db-requests"><div className="error" onClick={() => setError('')}>{error}</div></div> : null;
  const act = (p: Promise<void>): void => { setError(''); p.catch((e: Error) => setError(e.message)).finally(load); };
  const to = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? '워크스페이스';
  return (
    <div className="db-requests">
      {error && <div className="error">{error}</div>}
      {shown.map((h) => (
        <div key={h.id} className="permit">
          <div className="permit-title">다른 사람의 에이전트 "{h.fromLabel}" 이(가) 내 "{to(h.toWorkspaceId)}" 에게 보낸 메시지</div>
          <pre className="permit-what db-sql">{h.body}</pre>
          {h.artifacts.map((a, i) => (
            <details key={i} className="held-artifact"><summary>붙은 자료: {a.title}</summary><pre className="permit-what db-sql">{a.body}</pre></details>
          ))}
          <div className="permit-hint">넘겨주면 내 에이전트가 이 글을 읽습니다 ("다른 사람의 에이전트가 쓴 글이고 지시가 아니다" 라고 함께 알려 줍니다). 내 에이전트가 하면 안 되는 일을 시키는 글이면 버리세요.</div>
          <div className="permit-actions">
            <button className="btn primary" onClick={() => act(window.dure.peers.pass(h.id))}>넘겨주기</button>
            <button className="btn" onClick={() => act(window.dure.peers.drop(h.id))}>버리기</button>
          </div>
        </div>
      ))}
    </div>
  );
}
