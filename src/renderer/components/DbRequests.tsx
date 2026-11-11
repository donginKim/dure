import { useCallback, useEffect, useState } from 'react';
import type { DbRequest, Workspace } from '@shared/types';

/**
 * 에이전트가 올린 DB 조회 요청. "물어보고 조회" 로 둔 연결은 사용자가 여기서 허용해야 실행된다.
 * workspaceId 를 주면 그 워크스페이스의 요청만 보인다.
 */
export function DbRequests({ projectId, workspaceId, workspaces }: { projectId: string; workspaceId?: string; workspaces: Workspace[] }) {
  const [requests, setRequests] = useState<DbRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    window.dure.db.requests(projectId).then(setRequests).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'db') load(); });
  }, [load]);

  const shown = workspaceId ? requests.filter((r) => r.workspaceId === workspaceId) : requests;
  if (shown.length === 0 && !error) return null;
  const decide = (r: DbRequest, allow: boolean, always = false): void => {
    setBusy(r.id); setError('');
    window.dure.db.decide(r.id, allow, always).catch((e: Error) => setError(e.message)).finally(() => { setBusy(null); load(); });
  };
  const who = (id: string): string => { const w = workspaces.find((x) => x.id === id); return !w ? '에이전트' : w.role === 'coordinator' ? '조율 에이전트' : `"${w.name}" 에이전트`; };

  return (
    <div className="db-requests">
      {error && <div className="error">{error}</div>}
      {shown.map((r) => (
        <div key={r.id} className="permit">
          <div className="permit-title">{who(r.workspaceId)}가 DB "{r.connectionName}" 을(를) 조회하려 합니다</div>
          <pre className="permit-what db-sql">{r.sql}</pre>
          <div className="permit-hint">조회 전용으로 실행됩니다 (100행, 10초까지). 결과는 에이전트의 대화에 들어갑니다.</div>
          <div className="permit-actions">
            <button className="btn primary" disabled={busy !== null} onClick={() => decide(r, true)}>{busy === r.id ? '조회하는 중…' : '허용'}</button>
            <button className="btn" disabled={busy !== null} onClick={() => decide(r, false)}>거부</button>
            <button className="btn ghost" disabled={busy !== null} title='이 연결을 "바로 조회" 로 바꿉니다. DB 탭에서 되돌릴 수 있습니다' onClick={() => decide(r, true, true)}>허용하고 이 연결은 앞으로 묻지 않기</button>
          </div>
        </div>
      ))}
    </div>
  );
}
