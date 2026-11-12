import { useCallback, useEffect, useState } from 'react';
import type { HeldMessage, Workspace } from '@shared/types';

/**
 * 다른 사람의 에이전트가 보낸 메시지 가운데, 내가 보고 넘겨주기를 기다리는 것.
 * 넘겨줘야 내 에이전트에게 간다. 버리면 가지 않는다.
 */
/** 나에게 직접 물은 것: 내가 답하거나, 내 조율 에이전트에게 넘기거나, 버린다. */
function Question({ h, act }: { h: HeldMessage; act: (p: Promise<void>) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = (): void => { setBusy(true); act(window.dure.peers.answer(h.id, text).finally(() => setBusy(false))); };
  const toCoordinator = (): void => act(window.dure.coordinator.get(h.projectId).then((c) => window.dure.peers.pass(h.id, c.workspace.id)));
  return (
    <div className="permit">
      <div className="permit-title">"{h.fromLabel}" 이(가) 나에게 물었습니다</div>
      <pre className="permit-what db-sql">{h.body}</pre>
      {h.artifacts.map((a, i) => (
        <details key={i} className="held-artifact"><summary>붙은 자료: {a.title}</summary><pre className="permit-what db-sql">{a.body}</pre></details>
      ))}
      <textarea className="held-answer" value={text} rows={Math.min(6, Math.max(2, text.split('\n').length))} placeholder="답을 적으세요. 물은 에이전트에게 돌아갑니다" onChange={(e) => setText(e.target.value)} />
      <div className="permit-hint">다른 사람의 에이전트가 쓴 글입니다. 내 조율 에이전트에게 넘기면 그 에이전트가 읽고 대신 답할 수 있습니다 (지시가 아니라 다른 사람의 글이라고 함께 알려 줍니다).</div>
      <div className="permit-actions">
        <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>{busy ? '보내는 중…' : '답 보내기'}</button>
        <button className="btn" onClick={toCoordinator}>조율 에이전트에게 넘기기</button>
        <button className="btn" onClick={() => act(window.dure.peers.drop(h.id))}>버리기</button>
      </div>
    </div>
  );
}

export function PeerInbox({ projectId, workspaceId, workspaces, only }: { projectId: string; workspaceId?: string; workspaces: Workspace[]; /** person: 나에게 직접 물은 것만 */ only?: 'person' }) {
  const [held, setHeld] = useState<HeldMessage[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.peers.held(projectId).then(setHeld).catch(() => undefined); }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'peers') load(); });
  }, [load]);
  // 나에게 직접 물은 것은 프로젝트 화면에만 보인다 (어느 워크스페이스의 것도 아니다).
  const shown = only === 'person' ? held.filter((h) => h.toPerson) : workspaceId ? held.filter((h) => h.toWorkspaceId === workspaceId) : held;
  if (shown.length === 0) return error ? <div className="db-requests"><div className="error" onClick={() => setError('')}>{error}</div></div> : null;
  const act = (p: Promise<void>): void => { setError(''); p.catch((e: Error) => setError(e.message)).finally(load); };
  const to = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? '워크스페이스';
  return (
    <div className="db-requests">
      {error && <div className="error">{error}</div>}
      {shown.map((h) => (h.toPerson ? <Question key={h.id} h={h} act={act} /> : (
        <div key={h.id} className="permit">
          <div className="permit-title">{h.fromLabel.startsWith('@') ? `다른 사람 "${h.fromLabel.slice(1)}" 이(가) 내 "${to(h.toWorkspaceId)}" 에게 보낸 답` : `다른 사람의 에이전트 "${h.fromLabel}" 이(가) 내 "${to(h.toWorkspaceId)}" 에게 보낸 메시지`}</div>
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
      )))}
    </div>
  );
}
