import { useCallback, useEffect, useState } from 'react';
import type { SlackRequest, Workspace } from '@shared/types';

/**
 * 에이전트가 올린 슬랙 읽기 요청. "물어보고 읽기" 로 둔 동안은 사용자가 여기서 허용해야 읽는다.
 * workspaceId 를 주면 그 워크스페이스의 요청만 보인다.
 */
export function SlackRequests({ projectId, workspaceId, workspaces }: { projectId: string; workspaceId?: string; workspaces: Workspace[] }) {
  const [requests, setRequests] = useState<SlackRequest[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirmAlways, setConfirmAlways] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    window.dure.slack.requests(projectId).then(setRequests).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'slack') load(); });
  }, [load]);

  const shown = workspaceId ? requests.filter((r) => r.workspaceId === workspaceId) : requests;
  if (shown.length === 0) return error ? <div className="db-requests"><div className="error" onClick={() => setError('')} title="누르면 닫힙니다">{error}</div></div> : null;
  const decide = (r: SlackRequest, allow: boolean, always = false): void => {
    setBusy((b) => new Set(b).add(r.id)); setError(''); setConfirmAlways(null);
    window.dure.slack.decide(r.id, allow, always).catch((e: Error) => setError(e.message)).finally(() => { setBusy((b) => { const n = new Set(b); n.delete(r.id); return n; }); load(); });
  };
  const who = (id: string): string => { const w = workspaces.find((x) => x.id === id); return !w ? '에이전트' : w.role === 'coordinator' ? '조율 에이전트' : `"${w.name}" 에이전트`; };

  return (
    <div className="db-requests">
      {error && <div className="error">{error}</div>}
      {shown.map((r) => (
        <div key={r.id} className="permit">
          <div className="permit-title">{who(r.workspaceId)}가 슬랙을 읽으려 합니다</div>
          <div className="permit-what">{r.what}</div>
          <div className="permit-hint">내 슬랙 계정이 볼 수 있는 내용을 읽습니다 (읽기만 하고 올리지 않습니다). 읽은 내용은 에이전트의 대화에 들어갑니다.</div>
          {confirmAlways === r.id ? (
            <div className="permit-actions">
              <span className="permit-hint">앞으로 에이전트가 묻지 않고 슬랙을 읽습니다 (내 계정이 볼 수 있는 모든 채널과 개인 메시지). 설정에서 되돌릴 수 있습니다.</span>
              <button className="btn primary" disabled={busy.has(r.id)} onClick={() => decide(r, true, true)}>그렇게 하기</button>
              <button className="btn ghost" onClick={() => setConfirmAlways(null)}>취소</button>
            </div>
          ) : (
            <div className="permit-actions">
              <button className="btn primary" disabled={busy.has(r.id)} onClick={() => decide(r, true)}>{busy.has(r.id) ? '읽는 중…' : '허용'}</button>
              <button className="btn" disabled={busy.has(r.id)} onClick={() => decide(r, false)}>거부</button>
              <button className="btn ghost" disabled={busy.has(r.id)} title='설정의 슬랙을 "바로 읽기" 로 바꿉니다' onClick={() => setConfirmAlways(r.id)}>허용하고 앞으로 묻지 않기</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
