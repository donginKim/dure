import { useCallback, useEffect, useState } from 'react';
import type { CoordinatorInfo, Project, Proposal, ProposalItem, Repo, Workspace } from '@shared/types';
import { STATUS_LABEL } from '../tree';
import { ChatPane } from './ChatPane';
import type { ConversationData } from './ConversationPanel';
import { describeError } from './WorkspaceView';

/** 조율 에이전트가 제안한 워크스페이스. 고치고, 빼고, 더한 뒤 승인해야 만들어진다. */
function ProposalCard({ proposal, repos }: { proposal: Proposal; repos: Repo[] }) {
  const [items, setItems] = useState<ProposalItem[]>(proposal.items);
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  // 저장소마다 고를 수 있는 브랜치를 받아 둔다.
  const repoIds = [...new Set(items.map((i) => i.repoId))].join(',');
  useEffect(() => {
    let alive = true;
    for (const id of repoIds.split(',').filter(Boolean)) {
      window.dure.repos.branches(id).then((list) => { if (alive) setBranches((b) => ({ ...b, [id]: list })); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [repoIds]);

  const patch = (i: number, p: Partial<ProposalItem>): void => setItems((list) => list.map((it, k) => (k === i ? { ...it, ...p } : it)));
  const add = (): void => {
    const repo = repos[0];
    if (repo) setItems((list) => [...list, { name: '', repoId: repo.id, baseBranch: branches[repo.id]?.[0] ?? 'main', role: '' }]);
  };
  const approve = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await window.dure.coordinator.approve(proposal.id, items.map((i) => ({ ...i, name: i.name.trim() }))); } catch (e) { setError(describeError((e as Error).message)); } finally { setBusy(false); }
  };
  const reject = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await window.dure.coordinator.reject(proposal.id, reason); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const ready = items.length > 0 && items.every((i) => i.name.trim() && i.repoId && i.baseBranch);

  return (
    <div className="permit proposal">
      <div className="permit-title">조율 에이전트가 워크스페이스 {proposal.items.length}개를 제안합니다</div>
      {proposal.note && <div className="proposal-note">{proposal.note}</div>}
      <div className="proposal-rows">
        {items.map((it, i) => (
          <div key={i} className="proposal-row">
            <div className="proposal-line">
              <input type="text" className="proposal-name" value={it.name} placeholder="워크스페이스 이름" onChange={(e) => patch(i, { name: e.target.value })} />
              <select value={it.repoId} title="저장소" onChange={(e) => patch(i, { repoId: e.target.value, baseBranch: branches[e.target.value]?.[0] ?? it.baseBranch })}>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select value={it.baseBranch} title="기준 브랜치: 이 브랜치에서 새 브랜치와 작업 폴더를 만듭니다" onChange={(e) => patch(i, { baseBranch: e.target.value })}>
                {!(branches[it.repoId] ?? []).includes(it.baseBranch) && <option value={it.baseBranch}>{it.baseBranch}</option>}
                {(branches[it.repoId] ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <button className="btn ghost" title="이 워크스페이스는 만들지 않습니다" onClick={() => setItems((list) => list.filter((_, k) => k !== i))}>빼기</button>
            </div>
            <input type="text" className="proposal-role" value={it.role} placeholder="맡을 일" onChange={(e) => patch(i, { role: e.target.value })} />
          </div>
        ))}
        {items.length === 0 && <div className="permit-hint">만들 워크스페이스가 없습니다. 더하거나 거절하세요.</div>}
      </div>
      {error && <div className="error">{error}</div>}
      {rejecting && (
        <input type="text" autoFocus className="proposal-role" value={reason} placeholder="거절하는 이유 (조율 에이전트에게 전해집니다. 비워도 됩니다)" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void reject(); }} />
      )}
      <div className="permit-actions">
        {!rejecting && <button className="btn primary" disabled={!ready || busy} onClick={() => void approve()}>{busy ? '만드는 중…' : `승인하고 ${items.length}개 만들기`}</button>}
        {!rejecting && <button className="btn" disabled={busy || repos.length === 0} onClick={add}>+ 더하기</button>}
        {!rejecting && <button className="btn" disabled={busy} onClick={() => setRejecting(true)}>거절</button>}
        {rejecting && <button className="btn" disabled={busy} onClick={() => void reject()}>거절하기</button>}
        {rejecting && <button className="btn ghost" disabled={busy} onClick={() => setRejecting(false)}>취소</button>}
        <span className="permit-hint">승인해야 만들어집니다. 저장소마다 새 브랜치와 작업 폴더가 생깁니다.</span>
      </div>
    </div>
  );
}

/**
 * 프로젝트의 "조율" 탭. 조율 에이전트와 대화한다: 기획서나 할 일을 주면 워크스페이스를 제안하고, 일을 나눠 시키고, 모아서 보고한다.
 */
export function CoordinatorPane({ project, repos, everyone, conversation, readOnly }: {
  project: Project; repos: Repo[];
  /** 이 프로젝트의 워크스페이스 전부 (이름을 찾는 데 쓴다) */
  everyone: Workspace[];
  conversation: ConversationData; readOnly: boolean;
}) {
  const [info, setInfo] = useState<CoordinatorInfo | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    window.dure.coordinator.get(project.id).then(setInfo).catch((e: Error) => setError(e.message));
  }, [project.id]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'coordinator' || topic === 'workspaces' || topic === 'projects') load(); });
  }, [load]);

  if (!info) return <div className="coord"><div className="chat-empty">{error || '조율 에이전트를 준비하는 중…'}</div></div>;
  const ws = info.workspace;
  const hasAgent = ws.status !== 'stopped';
  const start = (): void => {
    setError('');
    window.dure.terminals.startAgent(ws.id, { cols: 120, rows: 40 }).catch((e: Error) => setError(describeError(e.message)));
  };

  return (
    <div className="coord">
      <div className="coord-bar">
        <span className={`dot ${ws.status}`} />
        <span className="coord-name">조율 에이전트</span>
        <span className="tag">{STATUS_LABEL[ws.status]}</span>
        <span className="coord-help">프로젝트 전체를 맡습니다. 워크스페이스를 제안하고, 일을 나눠 시키고, 모아서 보고합니다. 코드는 직접 고치지 않습니다.</span>
        <span className="spacer" />
        {(ws.status === 'working' || ws.status === 'waiting_user') && (
          <button className="btn" title="하던 일을 멈춥니다. 꺼지지 않습니다" onClick={() => { window.dure.workspaces.interrupt(ws.id).catch((e: Error) => setError(e.message)); }}>멈춤</button>
        )}
        {hasAgent && <button className="btn ghost" title="조율 에이전트를 끕니다. 대화는 남아 있어 다시 시작하면 이어집니다" onClick={() => { window.dure.workspaces.stopAgent(ws.id).catch((e: Error) => setError(e.message)); }}>끄기</button>}
      </div>
      {error && <div className="error" style={{ margin: '8px 16px 0' }}>{error}</div>}
      <ChatPane
        workspace={ws} workspaces={everyone} conversation={conversation} hasAgent={hasAgent} readOnly={readOnly}
        onShowTerminal={() => undefined} onStartAgent={start}
        blank={repos.length === 0
          ? '먼저 "현황" 탭에서 저장소를 등록하세요. 조율 에이전트는 등록된 저장소를 보고 워크스페이스를 제안합니다.'
          : '기획서를 붙여 넣거나 할 일을 쓰세요. 조율 에이전트가 필요한 워크스페이스를 제안하고, 승인하면 일을 나눠 시킵니다.'}
        banner={info.proposal && !readOnly ? <ProposalCard key={info.proposal.id} proposal={info.proposal} repos={repos} /> : null}
      />
    </div>
  );
}
