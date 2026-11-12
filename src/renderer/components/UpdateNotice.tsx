import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/types';

/** 새 버전을 알리고 업데이트한다 (소스에서 설치한 앱에서만 보인다). 사이드바 아래에 놓인다. */
export function UpdateNotice() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.update.status().then(setSt).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'update') load(); });
  }, [load]);
  if (!st || !st.supported) return null;
  const apply = (): void => {
    setBusy(true); setError('');
    window.dure.update.apply().catch((e: Error) => { setError(e.message); setBusy(false); });
  };
  if (st.last && !st.last.ok) {
    return (
      <div className="update-note bad">
        <div>지난 업데이트가 끝나지 못했습니다. 앞의 버전 그대로입니다.</div>
        <div className="update-sub">기록: {st.logPath}</div>
        <div className="update-actions">
          <button className="btn" onClick={() => { void window.dure.update.dismiss(); }}>닫기</button>
        </div>
      </div>
    );
  }
  if (st.last?.ok && !st.available) {
    return (
      <div className="update-note">
        <div>업데이트했습니다 (버전 {st.installed}).</div>
        <div className="update-actions"><button className="btn ghost" onClick={() => { void window.dure.update.dismiss(); }}>닫기</button></div>
      </div>
    );
  }
  if (!st.available) return null;
  return (
    <div className="update-note">
      <div><b>새 버전이 있습니다</b> · 변경 {st.behind}개</div>
      {open && (
        <>
          <ul className="update-changes">{st.changes.map((c, i) => <li key={i}>{c}</li>)}{st.behind > st.changes.length && <li>… 그 밖에 {st.behind - st.changes.length}개</li>}</ul>
          <div className="update-sub">업데이트하면 두레가 꺼지고, 새 소스를 받아 다시 만든 뒤 스스로 다시 켜집니다 (몇 분 걸립니다). 켜져 있는 에이전트와 터미널은 꺼집니다. 대화와 데이터는 그대로 남습니다.</div>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="update-actions">
        {open
          ? <button className="btn primary" disabled={busy} onClick={apply}>{busy ? '두레를 끄는 중…' : '지금 업데이트'}</button>
          : <button className="btn primary" onClick={() => setOpen(true)}>업데이트…</button>}
        {open && <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>나중에</button>}
      </div>
    </div>
  );
}

/** 설정의 "업데이트" 구역: 지금 버전과 "지금 확인". */
export function UpdateSettings() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const load = useCallback(() => { window.dure.update.status().then(setSt).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'update') load(); });
  }, [load]);
  if (!st) return null;
  return (
    <div className="section">
      <div className="section-head"><h2>업데이트</h2></div>
      <div className="set-box">
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">두레 업데이트</div>
            {st.supported ? (
              <div className="set-help">
                설치된 버전 {st.installed} · 소스 폴더 <code>{st.sourceDir}</code>
                <br />6시간마다 저장소에 새 버전이 있는지 확인합니다. 있으면 왼쪽 아래에 알림이 뜨고, 누르면 받아서 다시 만든 뒤 두레를 다시 켭니다.
                <br />{st.checking ? '확인하는 중…' : st.error ? st.error : st.checkedAt ? (st.available ? `새 버전이 있습니다 (변경 ${st.behind}개).` : '최신 버전입니다.') : '아직 확인하지 않았습니다.'}
              </div>
            ) : (
              <div className="set-help">이 두레는 앱 안에서 업데이트할 수 없습니다. 저장소를 받아 <code>bash scripts/install.sh</code> 로 설치한 앱에서만 됩니다 (설치 파일로 넣었거나 개발 모드로 띄운 경우에는 안 됩니다).</div>
            )}
          </div>
          <div className="set-control">
            {st.supported && <button className="btn" disabled={st.checking} onClick={() => { void window.dure.update.check().then(setSt); }}>지금 확인</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
