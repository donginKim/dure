import { useCallback, useEffect, useState } from 'react';
import type { BrowserRequest, Workspace } from '@shared/types';

/**
 * 에이전트가 내장 브라우저로 처음 여는 주소. 사용자가 허용해야 열린다.
 * 로컬 주소라도 묻는다: 이 PC 에 떠 있는 다른 프로그램의 화면일 수 있다.
 */
export function BrowserRequests({ projectId, workspaceId, workspaces }: { projectId: string; workspaceId?: string; workspaces: Workspace[] }) {
  const [requests, setRequests] = useState<BrowserRequest[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.browser.requests(projectId).then(setRequests).catch(() => undefined); }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'browser') load(); });
  }, [load]);
  const shown = workspaceId ? requests.filter((r) => r.workspaceId === workspaceId) : requests;
  if (shown.length === 0) return error ? <div className="db-requests"><div className="error" onClick={() => setError('')}>{error}</div></div> : null;
  const decide = (r: BrowserRequest, allow: boolean): void => { setError(''); window.dure.browser.decide(r.id, allow).catch((e: Error) => setError(e.message)).finally(load); };
  const who = (id: string): string => { const w = workspaces.find((x) => x.id === id); return w ? `"${w.name}" 에이전트` : '에이전트'; };
  return (
    <div className="db-requests">
      {error && <div className="error">{error}</div>}
      {shown.map((r) => (
        <div key={r.id} className="permit">
          <div className="permit-title">{who(r.workspaceId)}가 내장 브라우저로 {r.origin} 을(를) 열려 합니다</div>
          <pre className="permit-what db-sql">{r.url}</pre>
          <div className="permit-hint">허용하면 이 프로젝트의 에이전트가 이 주소의 페이지를 읽고, 누르고, 입력할 수 있습니다 (두레를 다시 켤 때까지). 페이지의 내용은 에이전트의 대화에 들어갑니다. 그 페이지가 다른 곳으로 보내는 요청까지 막지는 못하므로, 내가 띄우게 한 개발 서버가 맞는지 확인하세요.</div>
          <div className="permit-actions">
            <button className="btn primary" onClick={() => decide(r, true)}>허용</button>
            <button className="btn" onClick={() => decide(r, false)}>거부</button>
          </div>
        </div>
      ))}
    </div>
  );
}
