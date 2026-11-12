import { useCallback, useEffect, useState } from 'react';
import type { SlackAccess, SlackStatus } from '@shared/types';

const SCOPES = ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history', 'users:read', 'search:read'];

/** 설정의 "슬랙" 구역: 토큰을 넣어 연결하고, 에이전트가 읽을 때 물어볼지 정한다. */
export function SlackSettings() {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [guide, setGuide] = useState(false);
  const load = useCallback(() => { window.dure.slack.status().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'slack') load(); });
  }, [load]);
  if (!status) return null;
  const run = (p: Promise<unknown>): void => { setBusy(true); setError(''); p.catch((e: Error) => setError(e.message)).finally(() => { setBusy(false); load(); }); };

  return (
    <div className="section">
      <div className="section-head"><h2>슬랙</h2></div>
      <div className="set-box">
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">슬랙 연결</div>
            <div className="set-help">
              에이전트가 내 슬랙의 채널, 스레드, 검색 결과를 <b>읽을</b> 수 있게 합니다. 올리거나 고치지는 못합니다.
              내 사용자 토큰으로 접속하므로 <b>내가 볼 수 있는 모든 채널과 개인 메시지</b>가 읽을 수 있는 범위입니다. 토큰은 macOS 키체인의 열쇠로 암호화해 저장하고, 화면에도 에이전트에게도 다시 보이지 않습니다.
              {' '}<button className="link" onClick={() => setGuide((v) => !v)}>{guide ? '토큰 받는 법 접기' : '토큰 받는 법'}</button>
            </div>
            {guide && (
              <ol className="set-guide">
                <li><code>https://api.slack.com/apps</code> 에서 "Create New App → From scratch" 로 앱을 만듭니다 (이름은 아무것이나, 워크스페이스는 읽을 슬랙).</li>
                <li>"OAuth &amp; Permissions" 의 <b>User Token Scopes</b> 에 아래 권한을 더합니다 (Bot Token Scopes 가 아닙니다).<div className="set-scopes">{SCOPES.map((s) => <code key={s}>{s}</code>)}</div></li>
                <li>같은 화면 위의 "Install to Workspace" 를 누릅니다. 회사 슬랙이면 관리자의 승인을 기다려야 할 수 있습니다.</li>
                <li>설치되면 보이는 <b>User OAuth Token</b> (<code>xoxp-</code> 로 시작) 을 복사해 아래에 넣습니다.</li>
              </ol>
            )}
            {error && <div className="set-error">{error}</div>}
          </div>
          <div className="set-control">
            {status.connected ? (
              <>
                <span className="tag">{status.team} · {status.user}</span>
                <button className="btn" disabled={busy} onClick={() => run(window.dure.slack.disconnect())}>연결 끊기</button>
              </>
            ) : (
              <>
                <input type="password" className="set-input wide" value={token} placeholder="xoxp-…" autoComplete="off" spellCheck={false} onChange={(e) => setToken(e.target.value)} />
                <button className="btn primary" disabled={busy || !token.trim()} onClick={() => run(window.dure.slack.connect(token).then(() => setToken('')))}>{busy ? '확인하는 중…' : '연결'}</button>
              </>
            )}
          </div>
        </div>
        {status.connected && (
          <div className="set-row">
            <div className="set-text">
              <div className="set-label">에이전트가 읽을 때</div>
              <div className="set-help">"물어보고 읽기" 는 에이전트가 무엇을 읽으려는지 보여 주고 내가 허용해야 읽습니다. "바로 읽기" 는 묻지 않습니다: 에이전트가 내 계정이 볼 수 있는 것을 스스로 골라 읽습니다.</div>
            </div>
            <div className="set-control">
              <select className="set-select" value={status.access} disabled={busy} onChange={(e) => run(window.dure.slack.setAccess(e.target.value as SlackAccess))}>
                <option value="ask">물어보고 읽기</option>
                <option value="auto">바로 읽기</option>
                <option value="off">끔 (읽지 못함)</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
