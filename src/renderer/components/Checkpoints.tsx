import { useCallback, useEffect, useState } from 'react';
import type { Checkpoint, CheckpointPreview, Workspace } from '@shared/types';
import { noteTime } from '../notesView';

const KIND: Record<Checkpoint['kind'], string> = { auto: '시키기 전', manual: '직접 만듦', safety: '되돌리기 전' };

/**
 * 되돌리기 지점. 에이전트에게 일을 시킬 때마다 그 직전의 모습이 저절로 적힌다.
 * 고른 지점으로 작업 폴더를 되돌린다 (그 뒤의 커밋도 함께). 되돌리기 직전의 모습도 지점으로 남아, 되돌린 것을 무를 수 있다.
 */
export function Checkpoints({ workspace }: { workspace: Workspace }) {
  const [list, setList] = useState<Checkpoint[]>([]);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; preview: CheckpointPreview | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const load = useCallback(() => { window.dure.checkpoints.list(workspace.id).then(setList).catch(() => undefined); }, [workspace.id]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'checkpoints') load(); });
  }, [load]);

  const ask = (id: string): void => {
    setError(''); setDone(''); setConfirm({ id, preview: null });
    window.dure.checkpoints.preview(id).then((preview) => setConfirm((c) => (c && c.id === id ? { id, preview } : c))).catch((e: Error) => { setError(e.message); setConfirm(null); });
  };
  const restore = (id: string): void => {
    setBusy(true); setError('');
    window.dure.checkpoints.restore(id)
      .then(() => { setDone('되돌렸습니다. 되돌리기 직전의 모습은 맨 위의 "되돌리기 전" 지점에 있습니다 (그것으로 되돌리면 무를 수 있습니다).'); setConfirm(null); })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const working = workspace.status === 'working' || workspace.status === 'starting';

  return (
    <div className="cp">
      <div className="cp-bar">
        <button className="btn ghost" onClick={() => setOpen((v) => !v)}>{open ? '▾' : '▸'} 되돌리기 지점 <span className="count">{list.length}</span></button>
        <span className="plan-hint">에이전트에게 시킬 때마다 그 직전의 모습이 저절로 적힙니다</span>
        <span className="spacer" />
        <button className="btn" onClick={() => { setError(''); window.dure.checkpoints.create(workspace.id).then(() => setOpen(true)).catch((e: Error) => setError(e.message)); }}>지금 모습 적어 두기</button>
      </div>
      {error && <div className="error">{error}</div>}
      {done && <div className="notice ok" onClick={() => setDone('')}>{done}</div>}
      {open && (
        <div className="rows cp-list">
          {list.length === 0 && <div className="rows-empty">아직 지점이 없습니다. 에이전트에게 일을 시키면 생깁니다.</div>}
          {list.map((c) => (
            <div key={c.id} className="cp-item">
              <div className="row">
                <span className={`tag cp-${c.kind}`}>{KIND[c.kind]}</span>
                <div className="grow cp-label">{c.label || '(이름 없음)'}</div>
                <span className="muted">{noteTime(c.createdAt)}</span>
                <button className="btn" disabled={working || busy} title={working ? '에이전트가 일하는 중에는 되돌릴 수 없습니다' : '작업 폴더를 이때의 모습으로 되돌립니다'} onClick={() => ask(c.id)}>이때로 되돌리기…</button>
              </div>
              {confirm?.id === c.id && (
                <div className="cp-confirm">
                  {!confirm.preview ? <span className="muted">무엇이 바뀌는지 보는 중…</span> : (
                    <>
                      <div>
                        <b>작업 폴더를 이때의 모습으로 되돌립니다.</b>{' '}
                        {confirm.preview.files.length === 0 && confirm.preview.commits === 0 ? '지금과 같은 모습이라 바뀌는 것이 없습니다.' : `파일 ${confirm.preview.files.length + confirm.preview.moreFiles}개가 바뀌거나 사라집니다${confirm.preview.commits ? `. 그 뒤에 한 커밋 ${confirm.preview.commits}개도 되돌려집니다 (원격에 올린 것은 원격에 남습니다)` : ''}.`}
                      </div>
                      {confirm.preview.files.length > 0 && <div className="cp-files">{confirm.preview.files.join('\n')}{confirm.preview.moreFiles > 0 && `\n… 그 밖에 ${confirm.preview.moreFiles}개`}</div>}
                      <div className="plan-hint">git 이 무시하는 파일(.env, node_modules 등)은 건드리지 않습니다. 되돌리기 직전의 모습도 지점으로 남습니다.</div>
                      <div className="permit-actions">
                        <button className="btn danger" disabled={busy} onClick={() => restore(c.id)}>{busy ? '되돌리는 중…' : '되돌리기'}</button>
                        <button className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>취소</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
