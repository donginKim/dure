import { useCallback, useEffect, useState } from 'react';
import type { FoundPeer, Peer, PeerMode, PeerRequest, PeerStatus, Project, ShareInvite } from '@shared/types';
import { MODE_HELP, MODE_LABEL, normalizeAddress, spokenCode, statusLine } from '../peersView';

const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/**
 * "사람" 화면. 같은 네트워크의 다른 두레를 찾아 연결하고, 연결된 사람마다 받는 방식을 정한다.
 * 연결은 양쪽이 같은 확인 코드를 보고 받은 쪽이 수락해야 된다.
 */
export function PeopleView({ projects, onOpenSettings }: { projects: Project[]; onOpenSettings: () => void }) {
  const [status, setStatus] = useState<PeerStatus | null>(null);
  const [found, setFound] = useState<FoundPeer[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [requests, setRequests] = useState<PeerRequest[]>([]);
  const [invites, setInvites] = useState<ShareInvite[]>([]);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [address, setAddress] = useState('');
  const [target, setTarget] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ids = projects.map((p) => p.id).join(',');
  const load = useCallback(() => {
    void Promise.all([window.dure.peers.status(), window.dure.peers.found(), window.dure.peers.list(), window.dure.peers.requests(), window.dure.peers.invites()])
      .then(([s, f, p, r, i]) => { setStatus(s); setFound(f); setPeers(p); setRequests(r); setInvites(i); }).catch((e: Error) => setError(clean(e)));
    void Promise.all(ids.split(',').filter(Boolean).map((id) => window.dure.peers.share(id).then((s) => (s ? id : null))))
      .then((list) => setShared(new Set(list.filter((x): x is string => x !== null)))).catch(() => undefined);
  }, [ids]);
  useEffect(() => {
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'peers' || topic === 'settings' || topic === 'projects') load(); });
    // 같은 네트워크에서 보이는 것은 조용히 바뀐다: 가끔 다시 읽는다.
    const timer = window.setInterval(load, 5000);
    return () => { off(); window.clearInterval(timer); };
  }, [load]);

  const run = (p: Promise<unknown>): void => { setBusy(true); setError(''); p.catch((e: Error) => setError(clean(e))).finally(() => { setBusy(false); load(); }); };
  const connect = (raw: string): void => {
    const a = normalizeAddress(raw);
    if (!a) { setError('주소는 "호스트:포트" 로 적으세요 (예: 192.168.0.12:47800).'); return; }
    run(window.dure.peers.connect(a).then(() => setAddress('')));
  };
  if (!status) return <div className="page"><h1>사람</h1></div>;
  const on = status.enabled && status.port !== null;
  const open = projects.filter((p) => p.status !== 'done' && !shared.has(p.id));

  return (
    <div className="page">
      <h1>사람</h1>
      <p className="lead">두레를 쓰는 다른 사람과 연결합니다. 연결한 사람과 프로젝트를 함께 열면, 서로 공개한 워크스페이스의 에이전트끼리 메시지를 주고받을 수 있습니다. 같은 네트워크(같은 사무실, 같은 VPN) 안에서만 됩니다.</p>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}

      <div className="section">
        <div className="section-head"><h2>내 두레</h2><button className="btn" onClick={onOpenSettings}>{status.enabled ? '설정에서 바꾸기' : '설정에서 켜기'}</button></div>
        <div className="rows"><div className={`row${status.error ? ' bad' : ''}`}><div className="grow">{statusLine(status)}</div></div></div>
      </div>

      {requests.length > 0 && (
        <div className="section">
          <div className="section-head"><h2>연결 요청 <span className="count">{requests.length}</span></h2></div>
          {requests.map((r) => (
            <div key={r.id} className="permit">
              <div className="permit-title">{r.direction === 'in' ? `"${r.name}" 이(가) 연결을 요청합니다` : `"${r.name}" 에게 연결을 요청했습니다`}</div>
              <div className="pair-code" title="두 화면의 숫자가 같아야 합니다">{spokenCode(r.code)}</div>
              <div className="permit-hint">상대에게 전화나 메신저로 물어 <b>상대 화면의 숫자와 같은지</b> 확인하세요. 다르면 다른 사람이 끼어든 것이니 누르지 마세요. 두 사람이 모두 눌러야 연결됩니다. 주소 {r.address} · 열쇠 지문 {r.fingerprint}</div>
              {r.keyChanged && <div className="db-warn">이미 연결했던 사람인데 열쇠가 달라졌습니다. 상대가 두레를 다시 깔았는지 확인하세요. 아니라면 누르지 마세요. 연결하면 그 사람이 참여하던 프로젝트와 공개 범위는 처음부터 다시 정해야 합니다.</div>}
              <div className="permit-hint">{r.confirmed ? '내가 확인했습니다. 상대가 누르기를 기다립니다.' : r.peerConfirmed ? '상대는 확인했습니다. 숫자가 같으면 누르세요.' : '아직 아무도 확인하지 않았습니다.'}</div>
              <div className="permit-actions">
                {!r.confirmed && <button className="btn primary" disabled={busy} onClick={() => run(window.dure.peers.accept(r.id))}>숫자가 같다 · 연결</button>}
                <button className="btn" disabled={busy} onClick={() => run(window.dure.peers.dismiss(r.id))}>{r.direction === 'in' ? '거절' : '요청 거두기'}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {invites.length > 0 && (
        <div className="section">
          <div className="section-head"><h2>받은 초대 <span className="count">{invites.length}</span></h2></div>
          {invites.map((inv) => (
            <div key={inv.id} className="permit">
              <div className="permit-title">"{inv.fromName}" 이(가) 프로젝트 "{inv.name}" 에 초대했습니다</div>
              <div className="permit-hint">내 프로젝트 하나에 이어 붙입니다. 참여해도 내 워크스페이스는 하나씩 공개하기 전에는 상대에게 보이지 않습니다.</div>
              <div className="permit-actions">
                <select value={target[inv.id] ?? ''} onChange={(e) => setTarget((t) => ({ ...t, [inv.id]: e.target.value }))}>
                  <option value="">이어 붙일 내 프로젝트 고르기</option>
                  {open.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn primary" disabled={busy || !target[inv.id]} onClick={() => run(window.dure.peers.acceptInvite(inv.id, target[inv.id]!))}>참여</button>
                <button className="btn" disabled={busy} onClick={() => run(window.dure.peers.declineInvite(inv.id))}>거절</button>
              </div>
              {open.length === 0 && <div className="permit-hint">이어 붙일 수 있는 프로젝트가 없습니다. 왼쪽에서 새 프로젝트를 만든 뒤 참여하세요.</div>}
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <div className="section-head"><h2>같은 네트워크에서 보이는 두레 <span className="count">{found.length}</span></h2></div>
        <div className="rows">
          {!on && <div className="rows-empty">"다른 사람과 연결" 을 켜야 찾을 수 있습니다.</div>}
          {on && found.length === 0 && <div className="rows-empty">보이는 두레가 없습니다. 상대도 "다른 사람과 연결" 을 켰는지 확인하세요. 회사 네트워크가 자동 찾기를 막으면 아래에 주소를 직접 적어 연결할 수 있습니다.</div>}
          {found.map((f) => (
            <div key={f.peerId} className="row">
              <div className="grow"><div>{f.name}</div><div className="path">{f.address}</div></div>
              {f.known ? <span className="tag">연결됨</span> : <button className="btn" disabled={busy} onClick={() => connect(f.address)}>연결 요청</button>}
            </div>
          ))}
        </div>
        {on && (
          <div className="people-manual">
            <input type="text" value={address} placeholder="주소로 직접 연결 (예: 192.168.0.12:47800)" onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') connect(address); }} />
            <button className="btn" disabled={busy || !address.trim()} onClick={() => connect(address)}>연결 요청</button>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head"><h2>연결된 사람 <span className="count">{peers.length}</span></h2></div>
        <div className="rows">
          {peers.length === 0 && <div className="rows-empty">연결된 사람이 없습니다.</div>}
          {peers.map((p) => (
            <div key={p.id} className="row">
              <span className={`dot ${p.online ? 'idle' : 'stopped'}`} title={p.online ? '같은 네트워크에서 보입니다' : '지금은 보이지 않습니다'} />
              <div className="grow">
                <div>{p.name} {!p.direct && <span className="tag" title="내가 직접 연결한 사람이 아니라, 함께하는 프로젝트의 참여자로 알게 된 사람입니다">프로젝트로 알게 됨</span>}</div>
                <div className="path">{p.address || '주소 모름'} · 열쇠 지문 {p.fingerprint}</div>
              </div>
              <select value={p.mode} title={MODE_HELP[p.mode]} onChange={(e) => run(window.dure.peers.setMode(p.id, e.target.value as PeerMode))}>
                {(['review', 'direct'] as PeerMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </select>
              <button className="btn ghost danger" disabled={busy} title="연결을 끊습니다. 이 사람과 함께하던 프로젝트도 끝납니다" onClick={() => run(window.dure.peers.remove(p.id))}>끊기</button>
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>받는 방식: "내가 보고 넘겨주기" 는 그 사람의 에이전트가 보낸 메시지를 내가 확인해야 내 에이전트에게 갑니다. "바로 전달" 은 곧장 갑니다.</p>
      </div>
    </div>
  );
}
