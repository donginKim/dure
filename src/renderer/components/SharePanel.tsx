import { useCallback, useEffect, useState } from 'react';
import type { Peer, Project, RemoteWorkspace, Share, ShareInvite, SharingAudience, Workspace, WorkspaceSharing } from '@shared/types';
import { AUDIENCE_LABEL } from '../peersView';
import { PeerInbox } from './PeerInbox';

const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/**
 * 프로젝트의 "함께" 탭. 이 프로젝트를 다른 사람과 함께 열고, 워크스페이스마다 누구에게 보일지 정한다.
 * 공개하지 않은 워크스페이스는 이름도 나가지 않고 메시지도 받지 않는다.
 */
export function SharePanel({ project, workspaces, everyone, readOnly, onOpenPeople }: {
  project: Project; workspaces: Workspace[]; everyone: Workspace[]; readOnly: boolean; onOpenPeople: () => void;
}) {
  const [share, setShare] = useState<Share | null | undefined>(undefined);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [invites, setInvites] = useState<ShareInvite[]>([]);
  const [sharing, setSharing] = useState<Record<string, WorkspaceSharing>>({});
  const [remote, setRemote] = useState<RemoteWorkspace[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ids = workspaces.map((w) => w.id).join(',');
  const load = useCallback(() => {
    void Promise.all([window.dure.peers.share(project.id), window.dure.peers.list(), window.dure.peers.invites(), window.dure.peers.remote(project.id)])
      .then(([s, p, i, r]) => { setShare(s); setPeers(p); setInvites(i); setRemote(r); }).catch((e: Error) => setError(clean(e)));
    void Promise.all(ids.split(',').filter(Boolean).map((id) => window.dure.peers.sharing(id)))
      .then((list) => setSharing(Object.fromEntries(list.map((s) => [s.workspaceId, s])))).catch(() => undefined);
  }, [project.id, ids]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'peers' || topic === 'workspaces') load(); });
  }, [load]);

  const run = (p: Promise<unknown>): void => { setBusy(true); setError(''); p.catch((e: Error) => setError(clean(e))).finally(() => { setBusy(false); load(); }); };
  if (share === undefined) return <div className="page"><div className="muted">읽는 중…</div></div>;

  if (share === null) {
    return (
      <div className="page">
        {error && <div className="error">{error}</div>}
        <div className="section">
          <div className="section-head"><h2>다른 사람과 함께하기</h2></div>
          <div className="rows"><div className="rows-empty">
            이 프로젝트는 나 혼자 쓰고 있습니다. 함께하는 프로젝트로 열면 연결된 사람을 초대할 수 있고, 서로 공개한 워크스페이스의 에이전트끼리 메시지를 주고받습니다.
            <br />열어도 내 워크스페이스는 하나씩 공개하기 전에는 아무에게도 보이지 않습니다. 주고받는 것은 메시지와 자료의 글뿐이고, 파일과 코드는 보내지 않습니다.
          </div></div>
          {!readOnly && <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={() => run(window.dure.peers.createShare(project.id))}>함께하는 프로젝트로 열기</button>
            <button className="btn" onClick={onOpenPeople}>사람 찾아 연결하기</button>
          </div>}
        </div>
        {!readOnly && invites.length > 0 && (
          <div className="section">
            <div className="section-head"><h2>받은 초대를 이 프로젝트에 이어 붙이기</h2></div>
            <div className="rows">
              {invites.map((inv) => (
                <div key={inv.id} className="row">
                  <div className="grow"><div>"{inv.fromName}" 의 "{inv.name}"</div></div>
                  <button className="btn primary" disabled={busy} onClick={() => run(window.dure.peers.acceptInvite(inv.id, project.id))}>이 프로젝트로 참여</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const others = share.members.filter((m) => !m.me);
  const invitable = peers.filter((p) => p.direct && !share.members.some((m) => m.peerId === p.id) && !share.invited.some((m) => m.peerId === p.id));
  const setAudience = (w: Workspace, audience: SharingAudience, list: string[] = []): void => run(window.dure.peers.setSharing(w.id, audience, list));

  return (
    <div className="page">
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      <PeerInbox projectId={project.id} workspaces={everyone} />

      <div className="section">
        <div className="section-head">
          <h2>함께하는 사람 <span className="count">{share.members.length}</span> <span className="plan-hint">{share.mine ? '내가 리더입니다' : `"${share.members.find((m) => m.owner)?.name ?? '다른 사람'}" 이(가) 리더인 프로젝트 "${share.name}" 입니다`}</span></h2>
          {!readOnly && <button className="btn ghost danger" disabled={busy} title={share.mine ? '함께하기를 끝냅니다. 참여자 모두에게서 끊깁니다 (계속하게 하려면 먼저 리더를 넘기세요). 프로젝트는 그대로입니다' : '이 프로젝트에서 나갑니다. 내 프로젝트는 그대로입니다'} onClick={() => run(window.dure.peers.leave(project.id))}>{share.mine ? '함께하기 끝내기' : '나가기'}</button>}
        </div>
        <div className="rows">
          {share.members.map((m) => (
            <div key={m.peerId} className="row">
              <span className={`dot ${m.online ? 'idle' : 'stopped'}`} title={m.online ? '켜져 있습니다 (방금 닿았습니다)' : '지금은 닿지 않습니다 (꺼져 있으면 메시지가 가지 않습니다)'} />
              <div className="grow">{m.name}{m.me && <span className="tag">나</span>}{m.owner && <span className="tag">리더</span>}</div>
              {share.mine && !m.me && !readOnly && peers.some((p) => p.id === m.peerId && p.direct) && (
                <button className="btn ghost" disabled={busy || !m.online} title={m.online ? '이 사람을 리더로 만듭니다. 나는 참여자로 남습니다' : '지금 닿지 않아 넘길 수 없습니다'}
                  onClick={() => { if (window.confirm(`"${m.name}" 에게 리더를 넘길까요?\n\n일을 나눠 주고 계획안 제안을 승인하는 자리가 그 사람에게 갑니다. 나는 참여자로 남고, 되돌리려면 그 사람이 다시 넘겨 줘야 합니다. 아직 참여하지 않은 초대는 거둬집니다.`)) run(window.dure.peers.handOver(project.id, m.peerId)); }}>리더 넘기기</button>
              )}
              {share.mine && !m.me && !readOnly && <button className="btn ghost" disabled={busy} onClick={() => run(window.dure.peers.removeMember(share.id, m.peerId))}>빼기</button>}
            </div>
          ))}
          {share.invited.map((m) => (
            <div key={m.peerId} className="row">
              <span className="dot stopped" />
              <div className="grow">{m.name}<span className="tag">초대 중</span> <span className="plan-hint">아직 참여하지 않았습니다</span></div>
              {!readOnly && <button className="btn ghost" disabled={busy} onClick={() => run(window.dure.peers.removeMember(share.id, m.peerId))}>초대 거두기</button>}
            </div>
          ))}
        </div>
        {share.mine && !readOnly && (
          <div className="people-manual">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">초대할 사람 고르기</option>
              {invitable.map((p) => <option key={p.id} value={p.id}>{p.name}{p.online ? '' : ' (지금 안 닿음)'}</option>)}
            </select>
            <button className="btn" disabled={busy || !pick} onClick={() => run(window.dure.peers.invite(share.id, pick).then(() => setPick('')))}>초대</button>
            {invitable.length === 0 && <button className="btn ghost" onClick={onOpenPeople}>사람 찾아 연결하기</button>}
          </div>
        )}
        {share.mine && (
          <div className="share-rule">
            <div className="grow">
              <b>참여자가 제안한 계획안</b>
              <div className="muted">참여자가 일을 나누거나 바꾸는 계획을 올리면 나에게 제안으로 옵니다. "승인 없이 반영" 은 다른 사람에게 일을 나눠 주기만 하는 제안에 듣습니다: 내가 보지 않아도 맡을 사람에게 배정으로 갑니다 (누가 제안했는지 적혀 갑니다). 내 PC 에 워크스페이스를 만들거나 프로젝트 TODO 를 더하는 제안은 늘 내가 검토합니다.</div>
            </div>
            <select value={share.suggestMode} disabled={busy || readOnly} onChange={(e) => run(window.dure.peers.setSuggestMode(project.id, e.target.value === 'auto' ? 'auto' : 'review'))}>
              <option value="review">내가 검토하고 승인</option>
              <option value="auto">승인 없이 반영</option>
            </select>
          </div>
        )}
        {!share.mine && <div className="help">이 프로젝트에서 일을 나누거나 바꾸려면 조율 탭에서 계획안을 만들어 "{share.members.find((m) => m.owner)?.name ?? '리더'}" 에게 제안으로 보냅니다. 그 사람이 승인하면 반영됩니다.</div>}
      </div>

      <div className="section">
        <div className="section-head"><h2>내 워크스페이스의 공개 범위 <span className="plan-hint">공개한 워크스페이스만 상대에게 이름이 보이고 메시지를 주고받습니다</span></h2></div>
        <div className="rows">
          {workspaces.length === 0 && <div className="rows-empty">워크스페이스가 없습니다.</div>}
          {workspaces.map((w) => {
            const s = sharing[w.id] ?? { workspaceId: w.id, audience: 'none' as SharingAudience, peers: [] };
            return (
              <div key={w.id} className="row share-row">
                <div className="grow">
                  <div>{w.name}</div>
                  {s.audience === 'selected' && (
                    <div className="share-pick">
                      {others.length === 0 && <span className="muted">아직 참여한 사람이 없습니다.</span>}
                      {others.map((m) => (
                        <label key={m.peerId} className="check">
                          <input type="checkbox" disabled={readOnly || busy} checked={s.peers.includes(m.peerId)} onChange={(e) => setAudience(w, 'selected', e.target.checked ? [...s.peers, m.peerId] : s.peers.filter((x) => x !== m.peerId))} /> {m.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <select value={s.audience} disabled={readOnly || busy} className={s.audience === 'none' ? '' : 'share-on'} onChange={(e) => setAudience(w, e.target.value as SharingAudience, s.peers)}>
                  {(['none', 'all', 'selected'] as SharingAudience[]).map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>다른 사람이 나에게 공개한 워크스페이스 <span className="count">{remote.length}</span></h2></div>
        <div className="rows">
          {remote.length === 0 && <div className="rows-empty">아직 없습니다. 상대가 자기 워크스페이스를 공개하면 여기에 보이고, 내 에이전트가 "이름@사람" 으로 메시지를 보낼 수 있습니다.</div>}
          {remote.map((r) => <div key={r.ref} className="row"><div className="grow"><div>{r.label}</div><div className="path">{r.peerName} 의 두레</div></div></div>)}
        </div>
      </div>
    </div>
  );
}
